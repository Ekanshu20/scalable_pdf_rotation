import os
import shutil
import uuid
import zipfile
import json
import base64
import fitz
import asyncio
from typing import List, Optional
from datetime import datetime, timedelta
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, WebSocket, WebSocketDisconnect, Depends, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from celery.result import AsyncResult
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import redis.asyncio as aioredis
from pydantic import BaseModel
from passlib.context import CryptContext
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from worker import app as celery_app, process_pdf_rotation
from database import init_db, SessionLocal, Job, JobStatus, User, Folder, FileRecord

# Initialize database
init_db()

# Rate limiting
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Scalable PDF Rotation API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Ensure base temporary directories exist
BASE_TMP_DIR = "/app/tmp"
os.makedirs(BASE_TMP_DIR, exist_ok=True)

# Mount the static directory to serve the frontend at the root
app.mount("/static", StaticFiles(directory="/app/static"), name="static")

@app.get("/")
async def serve_frontend():
    return FileResponse("/app/static/login.html")

@app.get("/dashboard")
async def serve_dashboard():
    return FileResponse("/app/static/index.html")

# --- AUTHENTICATION ---
SECRET_KEY = "your-super-secret-key-change-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7 # 7 days

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

class UserCreate(BaseModel):
    email: str
    password: str

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user

@app.post("/api/v1/auth/register")
def register(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.email == user.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    hashed_password = get_password_hash(user.password)
    new_user = User(email=user.email, hashed_password=hashed_password)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return {"message": "User registered successfully"}

@app.post("/api/v1/auth/login")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.email}, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/v1/auth/me")
def read_users_me(current_user: User = Depends(get_current_user)):
    return {"email": current_user.email, "id": current_user.id}

# --- FOLDERS ---
class FolderCreate(BaseModel):
    name: str

@app.post("/api/v1/folders")
def create_folder(folder: FolderCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_folder = Folder(name=folder.name, user_id=current_user.id)
    db.add(new_folder)
    db.commit()
    db.refresh(new_folder)
    return {"id": new_folder.id, "name": new_folder.name}

@app.get("/api/v1/folders")
def get_folders(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folders = db.query(Folder).filter(Folder.user_id == current_user.id).all()
    result = []
    for f in folders:
        file_count = db.query(FileRecord).filter(FileRecord.folder_id == f.id).count()
        result.append({"id": f.id, "name": f.name, "file_count": file_count, "created_at": f.created_at.isoformat()})
    return result

@app.get("/api/v1/folders/{folder_id}/files")
def get_folder_files(folder_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    files = db.query(FileRecord).filter(FileRecord.folder_id == folder_id).order_by(FileRecord.created_at.desc()).all()
    
    result = []
    for f in files:
        available = f.file_path and os.path.exists(f.file_path)
        result.append({
            "id": f.id,
            "filename": f.filename,
            "available": available,
            "created_at": f.created_at.isoformat()
        })
    
    # Also get jobs linked to this folder
    jobs = db.query(Job).filter(Job.folder_id == folder_id, Job.user_id == current_user.id).order_by(Job.created_at.desc()).all()
    job_list = []
    for j in jobs:
        job_list.append({
            "task_id": j.task_id,
            "status": j.status,
            "total_files": j.total_files,
            "total_pages": j.total_pages,
            "created_at": j.created_at.isoformat(),
            "completed_at": j.completed_at.isoformat() if j.completed_at else None,
        })
    
    return {"files": result, "jobs": job_list}

@app.get("/api/v1/folders/files/{file_id}/download")
def download_folder_file(file_id: int, token: str = None, db: Session = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    file_record = db.query(FileRecord).filter(FileRecord.id == file_id).first()
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    
    # Verify the folder belongs to the user
    folder = db.query(Folder).filter(Folder.id == file_record.folder_id, Folder.user_id == user.id).first()
    if not folder:
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not file_record.file_path or not os.path.exists(file_record.file_path):
        raise HTTPException(status_code=404, detail="File no longer available on disk (cleaned up after 24h)")
    
    return FileResponse(file_record.file_path, media_type="application/pdf", filename=file_record.filename)

@app.delete("/api/v1/folders/files/{file_id}")
def delete_folder_file(file_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    file_record = db.query(FileRecord).filter(FileRecord.id == file_id).first()
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
    
    # Verify the folder belongs to the user
    folder = db.query(Folder).filter(Folder.id == file_record.folder_id, Folder.user_id == current_user.id).first()
    if not folder:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db.delete(file_record)
    db.commit()
    
    if file_record.file_path and os.path.exists(file_record.file_path):
        try:
            os.remove(file_record.file_path)
        except Exception:
            pass
            
    return {"message": "File deleted"}

class DeleteFolderFilesBatchRequest(BaseModel):
    file_ids: List[int]

@app.post("/api/v1/folders/files/delete-batch")
def delete_folder_files_batch(request: DeleteFolderFilesBatchRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not request.file_ids:
        return {"message": "No files specified", "deleted_count": 0}
        
    # Get files to check access and paths
    files_to_delete = db.query(FileRecord).join(Folder).filter(
        FileRecord.id.in_(request.file_ids),
        Folder.user_id == current_user.id
    ).all()
    
    deleted_count = 0
    for f in files_to_delete:
        if f.file_path and os.path.exists(f.file_path):
            try:
                os.remove(f.file_path)
            except Exception:
                pass
        db.delete(f)
        deleted_count += 1
        
    db.commit()
    return {"message": f"Deleted {deleted_count} files", "deleted_count": deleted_count}

@app.delete("/api/v1/folders/{folder_id}")
def delete_folder(folder_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    # Delete associated file records first
    db.query(FileRecord).filter(FileRecord.folder_id == folder_id).delete()
    db.delete(folder)
    db.commit()
    return {"message": "Folder deleted"}

class RenameFolderRequest(BaseModel):
    name: str

class MoveJobRequest(BaseModel):
    folder_id: Optional[int] = None

@app.put("/api/v1/folders/{folder_id}")
def rename_folder(folder_id: int, request: RenameFolderRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    folder.name = request.name
    db.commit()
    return {"message": "Folder renamed", "name": folder.name}

@app.post("/api/v1/jobs/{task_id}/move")
def move_job_to_folder(task_id: str, request: MoveJobRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if request.folder_id:
        folder = db.query(Folder).filter(Folder.id == request.folder_id, Folder.user_id == current_user.id).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Target folder not found")
        job.folder_id = folder.id
        task_result = AsyncResult(task_id, app=celery_app)
        if task_result.status == 'SUCCESS' and task_result.result:
            output_folder = task_result.result.get("output_folder")
            if output_folder and os.path.exists(output_folder):
                db.query(FileRecord).filter(FileRecord.file_path.startswith(output_folder)).delete()
                for filename in os.listdir(output_folder):
                    new_file = FileRecord(folder_id=folder.id, filename=filename, file_path=os.path.join(output_folder, filename))
                    db.add(new_file)
    else:
        job.folder_id = None
        task_result = AsyncResult(task_id, app=celery_app)
        if task_result.status == 'SUCCESS' and task_result.result:
            output_folder = task_result.result.get("output_folder")
            if output_folder:
                db.query(FileRecord).filter(FileRecord.file_path.startswith(output_folder)).delete()
    db.commit()
    return {"message": "Moved successfully"}

@app.get("/api/v1/folders/{folder_id}/download_all")
def download_folder_all(folder_id: int, token: str = None, db: Session = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == user.id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    files = db.query(FileRecord).filter(FileRecord.folder_id == folder_id).all()
    if not files:
        raise HTTPException(status_code=404, detail="No files in folder")
        
    zip_filename = f"{folder.name}_all_files.zip".replace(' ', '_')
    zip_filepath = os.path.join(BASE_TMP_DIR, zip_filename)
    with zipfile.ZipFile(zip_filepath, 'w') as zipf:
        for f in files:
            if f.file_path and os.path.exists(f.file_path):
                zipf.write(f.file_path, arcname=f.filename)
    
    return FileResponse(zip_filepath, media_type="application/zip", filename=zip_filename)

@app.post("/api/v1/folders/{folder_id}/merge")
def merge_folder_pdfs(folder_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    files = db.query(FileRecord).filter(FileRecord.folder_id == folder_id).order_by(FileRecord.created_at.asc()).all()
    
    valid_paths = [f.file_path for f in files if f.file_path and os.path.exists(f.file_path) and f.file_path.lower().endswith('.pdf')]
    if len(valid_paths) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 valid PDFs to merge")
        
    merged_pdf = fitz.open()
    for path in valid_paths:
        try:
            doc = fitz.open(path)
            merged_pdf.insert_pdf(doc)
            doc.close()
        except Exception:
            pass
            
    merged_filename = f"Merged_{folder.name}.pdf".replace(' ', '_')
    merged_filepath = os.path.join(BASE_TMP_DIR, merged_filename)
    merged_pdf.save(merged_filepath)
    merged_pdf.close()
    
    new_file = FileRecord(folder_id=folder_id, filename=merged_filename, file_path=merged_filepath)
    db.add(new_file)
    db.commit()
    
    return {"message": "Merged successfully", "filename": merged_filename}

@app.get("/api/v1/dashboard")
def get_dashboard(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Return aggregated stats for the dashboard view."""
    total_jobs = db.query(Job).filter(Job.user_id == current_user.id).count()
    successful_jobs = db.query(Job).filter(Job.user_id == current_user.id, Job.status == JobStatus.SUCCESS.value).count()
    
    from sqlalchemy import func
    total_files_result = db.query(func.sum(Job.total_files)).filter(Job.user_id == current_user.id, Job.status == JobStatus.SUCCESS.value).scalar()
    total_pages_result = db.query(func.sum(Job.total_pages)).filter(Job.user_id == current_user.id, Job.status == JobStatus.SUCCESS.value).scalar()
    total_files = total_files_result or 0
    total_pages = total_pages_result or 0
    
    folder_count = db.query(Folder).filter(Folder.user_id == current_user.id).count()
    
    # Count rotated vs unchanged pages from Celery results
    pages_rotated = 0
    pages_unchanged = 0
    recent_jobs_db = db.query(Job).filter(Job.user_id == current_user.id).order_by(Job.created_at.desc()).limit(50).all()
    for job in recent_jobs_db:
        if job.status == JobStatus.SUCCESS.value:
            try:
                task_result = AsyncResult(job.task_id, app=celery_app)
                if task_result.status == 'SUCCESS' and task_result.result:
                    page_rotations = task_result.result.get('page_rotations', {})
                    for filename, rotations in page_rotations.items():
                        for page_num, rot in rotations.items():
                            if rot == 0:
                                pages_unchanged += 1
                            else:
                                pages_rotated += 1
            except Exception:
                pass
    
    # Recent 5 jobs for the dashboard table
    recent_jobs = db.query(Job).filter(Job.user_id == current_user.id).order_by(Job.created_at.desc()).limit(5).all()
    recent = []
    for j in recent_jobs:
        filenames = []
        if j.status == JobStatus.SUCCESS.value:
            try:
                task_result = AsyncResult(j.task_id, app=celery_app)
                if task_result.status == 'SUCCESS' and task_result.result:
                    page_rotations = task_result.result.get('page_rotations', {})
                    filenames = list(page_rotations.keys())
            except Exception:
                pass

        recent.append({
            "task_id": j.task_id,
            "status": j.status,
            "total_files": j.total_files,
            "total_pages": j.total_pages,
            "created_at": j.created_at.isoformat(),
            "completed_at": j.completed_at.isoformat() if j.completed_at else None,
            "filenames": filenames,
        })
    
    return {
        "total_jobs": total_jobs,
        "successful_jobs": successful_jobs,
        "total_files": total_files,
        "total_pages": total_pages,
        "pages_rotated": pages_rotated,
        "pages_unchanged": pages_unchanged,
        "folder_count": folder_count,
        "recent_jobs": recent,
    }


# --- CORE FUNCTIONALITY ---
@app.post("/api/v1/rotate")
@limiter.limit("5/minute")
async def start_rotation(
    request: Request,
    input_folder: str = Form(...),
    output_folder: str = Form(...),
    use_gpu: bool = Form(True),
    gpu_mem: int = Form(1500),
    num_workers: int = Form(1)
):
    """
    Legacy endpoint for submitting a PDF rotation job via server paths.
    """
    if not os.path.exists(input_folder):
        raise HTTPException(status_code=400, detail=f"Input folder not found on server: {input_folder}")
        
    os.makedirs(output_folder, exist_ok=True)
    
    task = process_pdf_rotation.delay(
        input_folder,
        output_folder,
        use_gpu,
        gpu_mem,
        num_workers
    )
    return {"message": "Job submitted successfully", "task_id": task.id}

@app.post("/api/v1/upload")
@limiter.limit("10/minute")
async def handle_upload(
    request: Request,
    files: List[UploadFile] = File(...),
    use_gpu: bool = Form(True),
    num_workers: int = Form(2),
    folder_id: Optional[int] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")
        
    if folder_id:
        folder = db.query(Folder).filter(Folder.id == folder_id, Folder.user_id == current_user.id).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")

    session_id = str(uuid.uuid4())
    input_folder = os.path.join(BASE_TMP_DIR, session_id, "input")
    output_folder = os.path.join(BASE_TMP_DIR, session_id, "output")
    
    os.makedirs(input_folder, exist_ok=True)
    os.makedirs(output_folder, exist_ok=True)
    
    # Save files
    valid_pdf_count = 0
    total_pages_count = 0
    for file in files:
        if file.filename.lower().endswith(".pdf"):
            file_path = os.path.join(input_folder, os.path.basename(file.filename))
            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
            
            try:
                doc = fitz.open(file_path)
                total_pages_count += doc.page_count
                doc.close()
                valid_pdf_count += 1
                
                if folder_id:
                    new_file = FileRecord(folder_id=folder_id, filename=file.filename, file_path=os.path.join(output_folder, os.path.basename(file.filename)))
                    db.add(new_file)
            except Exception:
                pass
                
    if valid_pdf_count == 0:
         raise HTTPException(status_code=400, detail="No valid PDF files found.")
         
    db.commit()

    # Dispatch to Celery
    task = process_pdf_rotation.delay(
        input_folder,
        output_folder,
        use_gpu,
        gpu_mem=1500,
        num_workers=num_workers
    )
    
    # Record job in database
    new_job = Job(
        task_id=task.id,
        session_id=session_id,
        user_id=current_user.id,
        folder_id=folder_id,
        total_files=valid_pdf_count,
        total_pages=total_pages_count,
        status=JobStatus.PROCESSING.value
    )
    db.add(new_job)
    db.commit()
    
    return {
        "message": "Files uploaded and job submitted",
        "task_id": task.id,
        "session_id": session_id,
        "total_files": valid_pdf_count,
        "total_pages": total_pages_count
    }

@app.get("/api/v1/history")
async def get_history(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    jobs = db.query(Job).filter(Job.user_id == current_user.id).order_by(Job.created_at.desc()).limit(20).all()
    
    # Sync PROCESSING jobs with Celery state
    for job in jobs:
        if job.status == JobStatus.PROCESSING.value:
            task_result = AsyncResult(job.task_id, app=celery_app)
            if task_result.status == 'SUCCESS':
                job.status = JobStatus.SUCCESS.value
                job.completed_at = datetime.utcnow()
            elif task_result.status == 'FAILED':
                job.status = JobStatus.FAILED.value
                job.error_message = str(task_result.result)
                job.completed_at = datetime.utcnow()
    db.commit()
    
    result = []
    for j in jobs:
        # Try to get rotation breakdown and filenames from Celery result
        pages_rotated = 0
        pages_unchanged = 0
        filenames = []
        if j.status == JobStatus.SUCCESS.value:
            try:
                task_result = AsyncResult(j.task_id, app=celery_app)
                if task_result.status == 'SUCCESS' and task_result.result:
                    page_rotations = task_result.result.get('page_rotations', {})
                    filenames = list(page_rotations.keys())
                    for fname, rotations in page_rotations.items():
                        for pnum, rot in rotations.items():
                            if rot == 0:
                                pages_unchanged += 1
                            else:
                                pages_rotated += 1
            except Exception:
                pass
        
        folder_name = None
        if j.folder_id:
            folder = db.query(Folder).filter(Folder.id == j.folder_id).first()
            if folder:
                folder_name = folder.name
                
        result.append({
            "task_id": j.task_id,
            "status": j.status,
            "total_files": j.total_files,
            "total_pages": j.total_pages,
            "pages_rotated": pages_rotated,
            "pages_unchanged": pages_unchanged,
            "created_at": j.created_at.isoformat(),
            "completed_at": j.completed_at.isoformat() if j.completed_at else None,
            "error_message": j.error_message,
            "folder_id": j.folder_id,
            "folder_name": folder_name,
            "filenames": filenames,
        })
    
    return result

class DeleteHistoryBatchRequest(BaseModel):
    task_ids: List[str]

@app.delete("/api/v1/history/{task_id}")
def delete_history_job(task_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    db.delete(job)
    db.commit()
    return {"message": "Job deleted from history"}

@app.post("/api/v1/history/delete-batch")
def delete_history_batch(request: DeleteHistoryBatchRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not request.task_ids:
        return {"message": "No jobs specified", "deleted_count": 0}
    
    count = db.query(Job).filter(
        Job.task_id.in_(request.task_ids),
        Job.user_id == current_user.id
    ).delete(synchronize_session=False)
    
    db.commit()
    return {"message": f"Deleted {count} history entries", "deleted_count": count}

@app.delete("/api/v1/history")
def clear_all_history(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(Job).filter(Job.user_id == current_user.id).delete()
    db.commit()
    return {"message": "All history cleared"}

@app.get("/api/v1/status/{task_id}")
async def get_status(task_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    task_result = AsyncResult(task_id, app=celery_app)
    response = {"task_id": task_id, "status": task_result.status}
    
    if task_result.status == 'SUCCESS':
        response["result"] = task_result.result
        if job.status != JobStatus.SUCCESS.value:
            job.status = JobStatus.SUCCESS.value
            job.completed_at = datetime.utcnow()
            db.commit()
    elif task_result.status == 'FAILED':
        response["error"] = str(task_result.result)
        if job.status != JobStatus.FAILED.value:
            job.status = JobStatus.FAILED.value
            job.error_message = str(task_result.result)
            job.completed_at = datetime.utcnow()
            db.commit()
    elif task_result.status == 'PROCESSING':
        response["details"] = task_result.info
        if job.status != JobStatus.PROCESSING.value:
            job.status = JobStatus.PROCESSING.value
            db.commit()
        
    return response

@app.get("/api/v1/preview/{task_id}")
async def get_preview(task_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    output_folder = task_result.result.get("output_folder")
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    files = [f for f in os.listdir(output_folder) if f.endswith('.pdf')]
    if not files:
        raise HTTPException(status_code=404, detail="No processed PDFs found.")
        
    first_pdf_path = os.path.join(output_folder, files[0])
    try:
        doc = fitz.open(first_pdf_path)
        page = doc.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(0.5, 0.5))
        img_data = pix.tobytes("png")
        doc.close()
        return {"image": base64.b64encode(img_data).decode('utf-8')}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate preview: {str(e)}")

@app.get("/api/v1/download/{task_id}")
async def download_results(task_id: str, token: str = None, db: Session = Depends(get_db)):
    # Since download is usually a direct link, we might pass token in query param
    if not token:
        raise HTTPException(status_code=401, detail="Token required in query for download")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
        
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
        
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    output_folder = task_result.result.get("output_folder")
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    files = [f for f in os.listdir(output_folder) if f.lower().endswith('.pdf')]
    if not files:
        raise HTTPException(status_code=404, detail="No processed PDFs found.")
        
    if len(files) == 1:
        file_path = os.path.join(output_folder, files[0])
        return FileResponse(file_path, media_type="application/pdf", filename=files[0])
    else:
        zip_filename = f"{task_id}.zip"
        zip_filepath = os.path.join(BASE_TMP_DIR, zip_filename)
        with zipfile.ZipFile(zip_filepath, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, fs in os.walk(output_folder):
                for file in fs:
                    if file.lower().endswith('.pdf'):
                        file_path = os.path.join(root, file)
                        zipf.write(file_path, arcname=file)
                        
        return FileResponse(zip_filepath, media_type="application/zip", filename="rotated_pdfs.zip")

class OverrideRequest(BaseModel):
    filename: str
    page: int
    rotation: int

@app.get("/api/v1/compare/{task_id}")
async def get_compare_preview(task_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    result_data = task_result.result
    output_folder = result_data.get("output_folder")
    input_folder = output_folder.replace("output", "input")
    page_rotations = result_data.get("page_rotations", {})
    
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    files = [f for f in os.listdir(output_folder) if f.lower().endswith('.pdf')]
    if not files:
        raise HTTPException(status_code=404, detail="No processed PDFs found.")
        
    compare_data = {}
    for filename in files:
        in_path = os.path.join(input_folder, filename)
        out_path = os.path.join(output_folder, filename)
        
        try:
            in_doc = fitz.open(in_path)
            out_doc = fitz.open(out_path)
            
            num_pages = min(in_doc.page_count, 20)
            page_data = []
            
            file_rotations = page_rotations.get(filename, {})
            
            for i in range(num_pages):
                in_page = in_doc.load_page(i)
                out_page = out_doc.load_page(i)
                
                # Render thumbnails
                # 300px wide -> Matrix 0.5 roughly
                matrix = fitz.Matrix(0.5, 0.5)
                
                in_pix = in_page.get_pixmap(matrix=matrix)
                out_pix = out_page.get_pixmap(matrix=matrix)
                
                # Celery JSON dict keys might be string if serialized
                rot_val = file_rotations.get(i)
                if rot_val is None:
                    rot_val = file_rotations.get(str(i), 0)
                    
                page_data.append({
                    "page_num": i,
                    "rotation": rot_val,
                    "original_img": base64.b64encode(in_pix.tobytes("png")).decode('utf-8'),
                    "corrected_img": base64.b64encode(out_pix.tobytes("png")).decode('utf-8')
                })
                
            in_doc.close()
            out_doc.close()
            
            compare_data[filename] = page_data
        except Exception as e:
            print(f"Error loading {filename}: {e}")
            
    return compare_data

@app.post("/api/v1/override/{task_id}")
async def override_page(task_id: str, req: OverrideRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == current_user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    output_folder = task_result.result.get("output_folder")
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    pdf_path = os.path.join(output_folder, req.filename)
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="File not found.")
        
    try:
        doc = fitz.open(pdf_path)
        page = doc.load_page(req.page)
        
        # Apply the new manual rotation (accumulative)
        current_rot = page.rotation
        new_rot = (current_rot + req.rotation) % 360
        page.set_rotation(new_rot)
        doc.saveIncr()
        
        # Reload to get the new thumbnail
        page = doc.load_page(req.page)
        matrix = fitz.Matrix(0.5, 0.5)
        pix = page.get_pixmap(matrix=matrix)
        img_b64 = base64.b64encode(pix.tobytes("png")).decode('utf-8')
        
        doc.close()
        
        return {"message": "Success", "image": img_b64}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to override rotation: {e}")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

@app.websocket("/ws/progress/{task_id}")
async def websocket_endpoint(websocket: WebSocket, task_id: str):
    await websocket.accept()
    
    redis = await aioredis.from_url(REDIS_URL)
    pubsub = redis.pubsub()
    channel_name = f"task_progress_{task_id}"
    await pubsub.subscribe(channel_name)
    
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message:
                data = message['data'].decode('utf-8')
                await websocket.send_text(data)
                msg_dict = json.loads(data)
                if msg_dict.get('status') in ['SUCCESS', 'FAILED']:
                    break
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await pubsub.unsubscribe(channel_name)
        await redis.close()
