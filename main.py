import os
import shutil
import uuid
import zipfile
import json
import base64
import fitz
import asyncio
import math
from typing import List, Optional
from datetime import datetime, timedelta
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, WebSocket, WebSocketDisconnect, Depends, status
from fastapi.responses import FileResponse, JSONResponse, Response
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
from sqlalchemy import or_

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

@app.get("/api/v1/files/unfiled")
def get_unfiled_files(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Files uploaded without picking a folder - tracked by user_id instead of folder_id."""
    files = db.query(FileRecord).filter(
        FileRecord.folder_id.is_(None), FileRecord.user_id == current_user.id
    ).order_by(FileRecord.created_at.desc()).all()

    result = []
    for f in files:
        available = f.file_path and os.path.exists(f.file_path)
        result.append({
            "id": f.id,
            "filename": f.filename,
            "available": available,
            "created_at": f.created_at.isoformat()
        })

    jobs = db.query(Job).filter(
        Job.folder_id.is_(None), Job.user_id == current_user.id
    ).order_by(Job.created_at.desc()).all()
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

    # Verify the file belongs to the user - via its folder, or directly for unfiled uploads
    if file_record.folder_id is not None:
        folder = db.query(Folder).filter(Folder.id == file_record.folder_id, Folder.user_id == user.id).first()
        if not folder:
            raise HTTPException(status_code=403, detail="Access denied")
    elif file_record.user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    if not file_record.file_path or not os.path.exists(file_record.file_path):
        raise HTTPException(status_code=404, detail="File no longer available on disk (cleaned up after 24h)")

    return FileResponse(file_record.file_path, media_type="application/pdf", filename=file_record.filename)

@app.delete("/api/v1/folders/files/{file_id}")
def delete_folder_file(file_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    file_record = db.query(FileRecord).filter(FileRecord.id == file_id).first()
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")

    # Verify the file belongs to the user - via its folder, or directly for unfiled uploads
    if file_record.folder_id is not None:
        folder = db.query(Folder).filter(Folder.id == file_record.folder_id, Folder.user_id == current_user.id).first()
        if not folder:
            raise HTTPException(status_code=403, detail="Access denied")
    elif file_record.user_id != current_user.id:
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
        
    # Get files to check access and paths. outerjoin so unfiled files (folder_id
    # None) are still matched, via FileRecord.user_id instead of Folder.user_id.
    files_to_delete = db.query(FileRecord).outerjoin(Folder, FileRecord.folder_id == Folder.id).filter(
        FileRecord.id.in_(request.file_ids),
        or_(Folder.user_id == current_user.id, FileRecord.user_id == current_user.id)
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

class DeleteFoldersBatchRequest(BaseModel):
    folder_ids: List[int]

@app.post("/api/v1/folders/delete-batch")
def delete_folders_batch(request: DeleteFoldersBatchRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not request.folder_ids:
        return {"message": "No folders specified", "deleted_count": 0}

    folders = db.query(Folder).filter(
        Folder.id.in_(request.folder_ids),
        Folder.user_id == current_user.id
    ).all()

    deleted_count = 0
    for folder in folders:
        db.query(FileRecord).filter(FileRecord.folder_id == folder.id).delete(synchronize_session=False)
        db.delete(folder)
        deleted_count += 1

    db.commit()
    return {"message": f"Deleted {deleted_count} folders", "deleted_count": deleted_count}

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
                    new_file = FileRecord(folder_id=folder.id, user_id=current_user.id, filename=filename, file_path=os.path.join(output_folder, filename))
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

@app.get("/api/v1/download_bulk")
def download_bulk(task_ids: str = "", folder_ids: str = "", token: str = None, db: Session = Depends(get_db)):
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
        
    tasks = [t.strip() for t in task_ids.split(",") if t.strip()]
    folders = [int(f.strip()) for f in folder_ids.split(",") if f.strip().isdigit()]
    
    if not tasks and not folders:
        raise HTTPException(status_code=400, detail="No tasks or folders specified")
        
    files_to_zip = [] # list of (filepath, arcname)
    
    # Collect files from tasks
    for task_id in tasks:
        job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == user.id).first()
        if job and job.status == 'SUCCESS':
            task_result = AsyncResult(task_id, app=celery_app)
            if task_result.status == 'SUCCESS' and task_result.result:
                output_folder = task_result.result.get("output_folder")
                if output_folder and os.path.exists(output_folder):
                    for filename in os.listdir(output_folder):
                        path = os.path.join(output_folder, filename)
                        arcname = f"job_{task_id[:8]}/{filename}"
                        files_to_zip.append((path, arcname))
                        
    # Collect files from folders
    for fid in folders:
        folder = db.query(Folder).filter(Folder.id == fid, Folder.user_id == user.id).first()
        if folder:
            file_records = db.query(FileRecord).filter(FileRecord.folder_id == fid).all()
            for fr in file_records:
                if fr.file_path and os.path.exists(fr.file_path):
                    arcname = f"folder_{folder.name}/{fr.filename}"
                    files_to_zip.append((fr.file_path, arcname))
                    
    if not files_to_zip:
        raise HTTPException(status_code=404, detail="No files found to download")
        
    zip_filename = f"bulk_download_{uuid.uuid4().hex[:8]}.zip"
    zip_filepath = os.path.join(BASE_TMP_DIR, zip_filename)
    
    with zipfile.ZipFile(zip_filepath, 'w') as zipf:
        for path, arcname in files_to_zip:
            zipf.write(path, arcname=arcname)
            
    return FileResponse(zip_filepath, media_type="application/zip", filename="bulk_download.zip")

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
    
    new_file = FileRecord(folder_id=folder_id, user_id=current_user.id, filename=merged_filename, file_path=merged_filepath)
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
    num_workers: int = Form(10)
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
    num_workers: int = Form(6),
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

                # Always record the file (folder_id may be None for unfiled uploads)
                # so its completion status is tracked in the DB, not just in the
                # live WebSocket session.
                new_file = FileRecord(
                    folder_id=folder_id,
                    user_id=current_user.id,
                    filename=file.filename,
                    file_path=os.path.join(output_folder, os.path.basename(file.filename))
                )
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
        
    # Hard budget on embedded images - this endpoint inlines base64 PNGs, so a large
    # batch would otherwise produce a response big enough to kill the browser tab.
    # The review screen (/api/v1/review + /api/v1/page-thumb) is the scalable path.
    MAX_COMPARE_IMAGES = 40
    images_used = 0

    compare_data = {}
    for filename in files:
        if images_used >= MAX_COMPARE_IMAGES:
            break

        in_path = os.path.join(input_folder, filename)
        out_path = os.path.join(output_folder, filename)

        try:
            in_doc = fitz.open(in_path)
            out_doc = fitz.open(out_path)

            num_pages = min(in_doc.page_count, 20, MAX_COMPARE_IMAGES - images_used)
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

            images_used += len(page_data)
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

        # Manually fixing a page counts as reviewing it
        reviewed = _load_reviewed(job)
        reviewed.add(_review_key(req.filename, req.page))
        _save_reviewed(job, reviewed)
        db.commit()

        return {"message": "Success", "image": img_b64}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to override rotation: {e}")

# --- REVIEW QUEUE ---
# The pipeline records per-rotation confidence scores for every page and flags the
# ones where it was effectively guessing. These endpoints let a user review only
# those pages instead of eyeballing the whole document.

def _user_from_token(token: Optional[str], db: Session) -> User:
    """Resolve a user from a query-param token (for <img>/<a> URLs that can't set headers)."""
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def _require_job(task_id: str, user: User, db: Session) -> Job:
    """Ownership check only - no Celery result fetch."""
    job = db.query(Job).filter(Job.task_id == task_id, Job.user_id == user.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

def _session_folders(job: Job):
    """
    Upload jobs always live at {BASE_TMP_DIR}/{session_id}/{input,output}, so hot paths
    can find their files without pulling the whole Celery result. That result grows with
    page count (~165 bytes/page), and fetching megabytes from Redis to render one
    thumbnail is what makes big jobs crawl.
    """
    if not job.session_id:
        return None, None
    base = os.path.join(BASE_TMP_DIR, job.session_id)
    return os.path.join(base, "input"), os.path.join(base, "output")

def _require_job_result(task_id: str, user: User, db: Session):
    """Fetch a finished job owned by this user, plus its Celery result payload."""
    job = _require_job(task_id, user, db)

    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS' or not task_result.result:
        raise HTTPException(status_code=400, detail="Task not complete yet.")
    return job, task_result.result

def _job_folders(job: Job, result: dict):
    """Output folder comes from the task result; input is derived from the job's session."""
    output_folder = result.get("output_folder")
    input_folder = os.path.join(BASE_TMP_DIR, job.session_id, "input") if job.session_id else None
    return input_folder, output_folder

def _safe_pdf_path(folder: str, filename: str) -> str:
    """Join a user-supplied filename to a folder without allowing path traversal."""
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not available")
    candidate = os.path.normpath(os.path.join(folder, os.path.basename(filename)))
    if not candidate.startswith(os.path.normpath(folder) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid filename")
    return candidate

def _review_key(filename: str, page: int) -> str:
    return f"{filename}::{page}"

def _load_reviewed(job: Job) -> set:
    if not job.reviewed_pages:
        return set()
    try:
        return set(json.loads(job.reviewed_pages))
    except (ValueError, TypeError):
        return set()

def _save_reviewed(job: Job, reviewed: set):
    job.reviewed_pages = json.dumps(sorted(reviewed))

@app.get("/api/v1/review/{task_id}")
def get_review(
    task_id: str,
    scope: str = "flagged",
    offset: int = 0,
    limit: int = 20,
    file: str = None,
    reason: str = None,
    goto: int = None,
    goto_file: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Metadata-only manifest of a job's pages - no images, so it stays small even for
    thousands of pages. Thumbnails are fetched one at a time from /api/v1/page-thumb.
    """
    job, result = _require_job_result(task_id, current_user, db)
    page_details = result.get("page_details", {})
    reviewed = _load_reviewed(job)

    limit = max(1, min(limit, 100))

    files_summary = []
    selected = []
    total_pages = 0
    total_flagged = 0

    for filename in sorted(page_details.keys()):
        pages = page_details[filename] or {}
        file_flagged = 0
        file_reviewed = 0

        for page_str, detail in pages.items():
            try:
                page_num = int(page_str)
            except (TypeError, ValueError):
                continue

            needs_review = bool(detail.get("needs_review"))
            is_reviewed = _review_key(filename, page_num) in reviewed
            if needs_review:
                file_flagged += 1
                if is_reviewed:
                    file_reviewed += 1

            # Every file still appears in files_summary so the UI can list them all;
            # only the selected file's pages are returned as review cards.
            matches_reason = not reason or detail.get("reason") == reason
            if (scope == "all" or needs_review) and (not file or filename == file) and matches_reason:
                selected.append({
                    "filename": filename,
                    "page": page_num,
                    "angle": detail.get("angle", 0),
                    "method": detail.get("method"),
                    "scores": detail.get("scores", {}),
                    "reason": detail.get("reason"),
                    "skew": detail.get("skew"),
                    "ink_ratio": detail.get("ink_ratio"),
                    "word_count": detail.get("word_count"),
                    "needs_review": needs_review,
                    "reviewed": is_reviewed,
                })

        total_pages += len(pages)
        total_flagged += file_flagged
        files_summary.append({
            "filename": filename,
            "total_pages": len(pages),
            "needs_review": file_flagged,
            "reviewed": file_reviewed,
            # Every single page was a guess - usually an image-only scan. The UI should
            # offer one bulk decision here instead of hundreds of review cards.
            "all_low_confidence": len(pages) > 0 and file_flagged == len(pages),
        })

    selected.sort(key=lambda p: (p["filename"], p["page"]))

    # "Go to page N" - resolve a document page number to the window containing it.
    # goto is 1-based to match what the UI displays.
    goto_found = None
    if goto is not None:
        target = goto - 1
        index = next(
            (i for i, p in enumerate(selected)
             if p["page"] == target and (not goto_file or p["filename"] == goto_file)),
            None
        )
        goto_found = index is not None
        if index is not None:
            offset = (index // limit) * limit

    offset = max(0, offset)
    page_window = selected[offset:offset + limit]

    return {
        "task_id": task_id,
        "goto_found": goto_found,
        "summary": {
            "total_pages": total_pages,
            "needs_review": total_flagged,
            "auto_corrected": total_pages - total_flagged,
            "reviewed": len(reviewed),
            "all_low_confidence": total_pages > 0 and total_flagged == total_pages,
        },
        "files": files_summary,
        "pages": page_window,
        "offset": offset,
        "limit": limit,
        "total": len(selected),
    }

GROUP_REASON_LABELS = {
    "no_text": "No readable text found at any rotation",
    "close_to_zero": "Barely beat leaving the page unrotated",
    "ambiguous": "Two rotations scored almost the same",
    "error": "Page failed to process",
    "blank": "Page appears to be blank",
    "skewed": "Page is tilted and may need straightening",
}

GROUP_REASON_HINTS = {
    "no_text": "Usually image-only scans. If the samples look upright, accept them all.",
    "close_to_zero": "The model nearly left these alone. Check a few samples before accepting.",
    "ambiguous": "The riskiest group - the top two rotations were close. Worth reviewing individually.",
    "error": "These pages could not be analysed and were left unchanged.",
    "blank": "Almost no ink detected. Usually separator sheets or scanning artefacts - often safe to accept, or drop them.",
    "skewed": "Orientation is correct but the scan is tilted. Rotation is right; the tilt needs straightening.",
}

# Groups the ambiguous cases first: those are the ones actually worth human eyes.
GROUP_REASON_ORDER = {"ambiguous": 0, "close_to_zero": 1, "skewed": 2, "error": 3, "blank": 4, "no_text": 5}

@app.get("/api/v1/review/{task_id}/groups")
def get_review_groups(
    task_id: str,
    samples: int = 6,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Bulk view: collapse flagged pages into patterns so a 5,000 page job becomes a
    handful of decisions instead of thousands of cards. Pages are grouped by why they
    were flagged and what the model decided, with a few representative samples each.
    """
    job, result = _require_job_result(task_id, current_user, db)
    page_details = result.get("page_details", {})
    reviewed = _load_reviewed(job)
    samples = max(1, min(samples, 12))

    groups = {}
    total_pages = 0
    total_flagged = 0

    for filename in sorted(page_details.keys()):
        pages = page_details[filename] or {}
        total_pages += len(pages)

        for page_str, detail in sorted(pages.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
            if not detail.get("needs_review"):
                continue
            try:
                page_num = int(page_str)
            except (TypeError, ValueError):
                continue

            total_flagged += 1
            reason = detail.get("reason") or "unknown"
            angle = detail.get("angle", 0)
            key = f"{reason}|{angle}"

            group = groups.setdefault(key, {
                "key": key,
                "reason": reason,
                "angle": angle,
                "label": GROUP_REASON_LABELS.get(reason, "Uncertain"),
                "hint": GROUP_REASON_HINTS.get(reason, ""),
                "count": 0,
                "reviewed": 0,
                "files": set(),
                "candidates": {},
            })
            group["count"] += 1
            group["files"].add(filename)
            if _review_key(filename, page_num) in reviewed:
                group["reviewed"] += 1

            per_file = group["candidates"].setdefault(filename, [])
            if len(per_file) < samples:
                per_file.append(page_num)

    ordered = sorted(
        groups.values(),
        key=lambda g: (GROUP_REASON_ORDER.get(g["reason"], 9), -g["count"])
    )

    for g in ordered:
        # Round-robin one page per file, then a second per file, and so on, so the
        # samples represent the whole group instead of the first document in it.
        sample = []
        depth = 0
        while len(sample) < samples and any(depth < len(v) for v in g["candidates"].values()):
            for fname, page_numbers in g["candidates"].items():
                if depth < len(page_numbers) and len(sample) < samples:
                    sample.append({"filename": fname, "page": page_numbers[depth]})
            depth += 1

        g["sample"] = sample
        g["files"] = len(g["files"])
        del g["candidates"]

    return {
        "task_id": task_id,
        "summary": {
            "total_pages": total_pages,
            "needs_review": total_flagged,
            "auto_corrected": total_pages - total_flagged,
            "reviewed": len(reviewed),
            "groups": len(ordered),
        },
        "groups": ordered,
    }

def _deskew_page(doc, page_num, skew_deg, dpi=200):
    """
    Straighten a tilted page by re-rendering it rotated.

    A PDF page's /Rotate only accepts multiples of 90, so fine skew can only be removed
    by rasterising. That is destructive - it discards vector content and inflates file
    size - which is why this is an explicit user action and only ever applied to
    image-only pages.

    The invisible OCR layer is captured first and re-applied at rotated coordinates, so
    the page stays searchable after straightening.
    """
    page = doc.load_page(page_num)

    # Capture whole LINES, not words. Re-inserting word by word loses the spacing and
    # reading order that make the layer searchable - phrases stop matching entirely.
    source_lines = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if text.strip():
                source_lines.append((line["bbox"], text))

    src_rect = fitz.Rect(page.rect)

    # Render the page pre-rotated by the opposite of the measured tilt
    matrix = fitz.Matrix(dpi / 72.0, dpi / 72.0).prerotate(-skew_deg)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    img_bytes = pix.tobytes("png")

    new_rect = fitz.Rect(0, 0, pix.width * 72.0 / dpi, pix.height * 72.0 / dpi)
    new_page = doc.new_page(pno=page_num + 1, width=new_rect.width, height=new_rect.height)
    new_page.insert_image(new_rect, stream=img_bytes)

    # Re-apply the text layer, rotated about the original page centre and re-centred
    theta = math.radians(-skew_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    cx, cy = src_rect.width / 2, src_rect.height / 2
    ncx, ncy = new_rect.width / 2, new_rect.height / 2

    for (x0, y0, x1, y1), text in source_lines:
        mx, my = (x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy
        rx = ncx + mx * cos_t - my * sin_t
        ry = ncy + mx * sin_t + my * cos_t

        width, height = max(x1 - x0, 1), max(y1 - y0, 1)
        fontsize = height * 0.9
        try:
            natural = fitz.get_text_length(text, fontname="helv", fontsize=fontsize)
            if natural > 0:
                fontsize *= width / natural
            new_page.insert_text(
                (rx - width / 2, ry + height * 0.35),
                text, fontname="helv",
                fontsize=max(min(fontsize, 100.0), 0.5),
                render_mode=3,
            )
        except Exception:
            continue

    doc.delete_page(page_num)
    return True

class GroupActionRequest(BaseModel):
    reason: str
    angle: int
    action: str            # "accept" | "rotate" | "deskew"
    rotate_by: int = 0

@app.post("/api/v1/review/{task_id}/group-action")
def review_group_action(
    task_id: str,
    req: GroupActionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Apply one decision to every page in a pattern group, across all files."""
    if req.action not in ("accept", "rotate", "deskew"):
        raise HTTPException(status_code=400, detail="Unknown action")
    if req.action == "rotate" and req.rotate_by % 90 != 0:
        raise HTTPException(status_code=400, detail="Angle must be a multiple of 90")

    job, result = _require_job_result(task_id, current_user, db)
    page_details = result.get("page_details", {})
    _, output_folder = _session_folders(job)
    reviewed = _load_reviewed(job)

    # Collect the group's pages per file so each PDF is opened and saved once,
    # not once per page.
    by_file = {}
    for filename, pages in page_details.items():
        for page_str, detail in (pages or {}).items():
            if not detail.get("needs_review"):
                continue
            if detail.get("reason") != req.reason or detail.get("angle", 0) != req.angle:
                continue
            try:
                by_file.setdefault(filename, []).append(int(page_str))
            except (TypeError, ValueError):
                continue

    if req.action == "deskew":
        for filename, page_numbers in by_file.items():
            pdf_path = _safe_pdf_path(output_folder, filename)
            if not os.path.exists(pdf_path):
                continue
            try:
                doc = fitz.open(pdf_path)
                # Descending order: replacing a page shifts the ones after it
                for page_num in sorted(page_numbers, reverse=True):
                    detail = (page_details.get(filename) or {}).get(str(page_num))                         or (page_details.get(filename) or {}).get(page_num) or {}
                    skew = detail.get("skew") or 0
                    if page_num < doc.page_count and abs(skew) >= 0.1:
                        _deskew_page(doc, page_num, skew)
                # Deskewing replaces pages, so this is a structural rewrite - PyMuPDF
                # refuses to save that over the file it is reading. Write beside it and
                # swap atomically.
                tmp_path = f"{pdf_path}.deskew.tmp"
                doc.save(tmp_path, deflate=True, garbage=3)
                doc.close()
                os.replace(tmp_path, pdf_path)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to straighten {filename}: {e}")

    if req.action == "rotate" and req.rotate_by % 360 != 0:
        for filename, page_numbers in by_file.items():
            pdf_path = _safe_pdf_path(output_folder, filename)
            if not os.path.exists(pdf_path):
                continue
            try:
                doc = fitz.open(pdf_path)
                for page_num in page_numbers:
                    if 0 <= page_num < doc.page_count:
                        pdf_page = doc.load_page(page_num)
                        pdf_page.set_rotation((pdf_page.rotation + req.rotate_by) % 360)
                doc.saveIncr()
                doc.close()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to rotate {filename}: {e}")

    affected = 0
    for filename, page_numbers in by_file.items():
        for page_num in page_numbers:
            reviewed.add(_review_key(filename, page_num))
            affected += 1

    _save_reviewed(job, reviewed)
    db.commit()
    return {
        "message": f"{req.action} applied to group",
        "pages": affected,
        "files": len(by_file),
        "reviewed": len(reviewed),
    }

def _extract_job_text(job, filename=None, page=None):
    """
    Read the OCR layer back out of the processed PDFs.

    The text is not stored separately - it lives in the output PDF as an invisible
    layer. Reading it back on demand means there is one source of truth, and it stays
    correct automatically after a page is rotated or straightened.
    """
    _, output_folder = _session_folders(job)
    if not output_folder or not os.path.exists(output_folder):
        raise HTTPException(status_code=404, detail="Output no longer available (cleaned up after 24h)")

    names = [filename] if filename else sorted(
        f for f in os.listdir(output_folder) if f.lower().endswith(".pdf")
    )

    files = []
    for name in names:
        pdf_path = _safe_pdf_path(output_folder, name)
        if not os.path.exists(pdf_path):
            continue
        try:
            doc = fitz.open(pdf_path)
            pages = []
            targets = [page] if page is not None else range(doc.page_count)
            for index in targets:
                if 0 <= index < doc.page_count:
                    body = doc.load_page(index).get_text().strip()
                    pages.append({"page": index, "text": body, "word_count": len(body.split())})
            doc.close()
            files.append({
                "filename": name,
                "pages": pages,
                "word_count": sum(p["word_count"] for p in pages),
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read text from {name}: {e}")

    return files

# --- Markdown reconstruction -------------------------------------------------
# The searchable layer keeps every line's bounding box, so the page's visual layout can
# be rebuilt rather than flattened into a wall of text: rows that share a baseline
# become table rows, oversized lines become headings.

MD_TABLE_MIN_CELLS = 3      # a row needs this many cells before it looks like a table
MD_HEADING_RATIO = 1.25     # line is a heading when this much larger than body text
MD_COLUMN_TOLERANCE = 0.04  # column clustering tolerance, as a share of page width

def _page_lines(page):
    """
    Lines with their bounding boxes mapped into DISPLAY space.

    get_text() reports coordinates in the page's unrotated mediabox. On a rotated page
    that axis-swaps the layout: cells of one visual table row come back sharing an x and
    differing in y. Everything downstream groups by visual rows, so apply the page's
    rotation matrix here once and let the rest of the code think in what the reader sees.
    """
    matrix = page.rotation_matrix
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            sizes = [s.get("size", 0) for s in spans if s.get("size")]
            rect = (fitz.Rect(line["bbox"]) * matrix).normalize()
            lines.append({
                "text": text,
                "bbox": (rect.x0, rect.y0, rect.x1, rect.y1),
                "size": max(sizes) if sizes else 0.0,
            })
    return lines

def _group_rows(lines):
    """Cluster lines that sit on the same visual row."""
    lines = sorted(lines, key=lambda l: (round(l["bbox"][1], 1), l["bbox"][0]))
    rows, current = [], []
    for line in lines:
        if not current:
            current = [line]
            continue
        height = max(line["bbox"][3] - line["bbox"][1], 1)
        centre_prev = sum((c["bbox"][1] + c["bbox"][3]) / 2 for c in current) / len(current)
        centre_now = (line["bbox"][1] + line["bbox"][3]) / 2
        if abs(centre_now - centre_prev) <= height * 0.6:
            current.append(line)
        else:
            rows.append(sorted(current, key=lambda c: c["bbox"][0]))
            current = [line]
    if current:
        rows.append(sorted(current, key=lambda c: c["bbox"][0]))
    return rows

def _md_escape(text):
    return text.replace("|", "\\|").replace("\n", " ").strip()

def _rows_to_table(rows, page_width):
    """Align a run of multi-cell rows onto shared column positions."""
    starts = sorted(cell["bbox"][0] for row in rows for cell in row)
    tolerance = page_width * MD_COLUMN_TOLERANCE
    columns = []
    for x in starts:
        if not columns or x - columns[-1] > tolerance:
            columns.append(x)

    table = []
    for row in rows:
        cells = [""] * len(columns)
        for cell in row:
            index = min(
                range(len(columns)),
                key=lambda i: abs(columns[i] - cell["bbox"][0])
            )
            cells[index] = (cells[index] + " " + _md_escape(cell["text"])).strip()
        table.append(cells)

    # Slight x jitter between rows invents columns nothing ever lands in; drop any
    # column that is empty everywhere rather than emitting a table full of "| |".
    keep = [i for i in range(len(columns)) if any(row[i].strip() for row in table)]
    if not keep:
        return []
    table = [[row[i] for i in keep] for row in table]

    header, *body = table
    out = ["| " + " | ".join(header) + " |",
           "| " + " | ".join("---" for _ in header) + " |"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return out

def _page_to_markdown(page):
    lines = _page_lines(page)
    if not lines:
        return ""

    sizes = sorted(l["size"] for l in lines if l["size"] > 0)
    body_size = sizes[len(sizes) // 2] if sizes else 0
    page_width = max(page.rect.width, 1)

    rows = _group_rows(lines)
    out, table_run = [], []

    def flush_table():
        if not table_run:
            return
        # A single wide row is more likely a heading spread across the page than a table
        if len(table_run) >= 2:
            out.extend(_rows_to_table(table_run, page_width))
            out.append("")
        else:
            out.append(" ".join(_md_escape(c["text"]) for c in table_run[0]))
            out.append("")
        table_run.clear()

    for row in rows:
        if len(row) >= MD_TABLE_MIN_CELLS:
            table_run.append(row)
            continue

        flush_table()
        text = " ".join(_md_escape(c["text"]) for c in row)
        if not text:
            continue

        biggest = max(c["size"] for c in row)
        if body_size and biggest >= body_size * MD_HEADING_RATIO * 1.2:
            out.append(f"# {text}")
        elif body_size and biggest >= body_size * MD_HEADING_RATIO:
            out.append(f"## {text}")
        else:
            out.append(text)
        out.append("")

    flush_table()
    return "\n".join(out).strip()

def _job_to_markdown(job, filename=None):
    _, output_folder = _session_folders(job)
    if not output_folder or not os.path.exists(output_folder):
        raise HTTPException(status_code=404, detail="Output no longer available (cleaned up after 24h)")

    names = [filename] if filename else sorted(
        f for f in os.listdir(output_folder) if f.lower().endswith(".pdf")
    )

    documents = []
    for name in names:
        pdf_path = _safe_pdf_path(output_folder, name)
        if not os.path.exists(pdf_path):
            continue
        try:
            doc = fitz.open(pdf_path)
            parts = [f"# {name}", ""]
            for index in range(doc.page_count):
                body = _page_to_markdown(doc.load_page(index))
                parts.append(f"## Page {index + 1}")
                parts.append("")
                parts.append(body if body else "_No text recognised on this page._")
                parts.append("")
            doc.close()
            documents.append({"filename": name, "markdown": "\n".join(parts).strip()})
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to build markdown for {name}: {e}")

    return documents

@app.get("/api/v1/markdown/{task_id}")
def get_job_markdown(
    task_id: str,
    filename: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Layout-aware Markdown rebuilt from the searchable layer's coordinates."""
    job = _require_job(task_id, current_user, db)
    return {"task_id": task_id, "documents": _job_to_markdown(job, filename)}

@app.get("/api/v1/markdown/{task_id}/download")
def download_job_markdown(task_id: str, token: str = None, db: Session = Depends(get_db)):
    user = _user_from_token(token, db)
    job = _require_job(task_id, user, db)
    documents = _job_to_markdown(job)

    body = "\n\n---\n\n".join(d["markdown"] for d in documents)
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{task_id[:8]}.md"'},
    )

@app.get("/api/v1/text/{task_id}")
def get_job_text(
    task_id: str,
    filename: str = None,
    page: int = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Text recognised during processing, straight from the searchable layer."""
    job = _require_job(task_id, current_user, db)
    files = _extract_job_text(job, filename, page)
    return {
        "task_id": task_id,
        "files": files,
        "word_count": sum(f["word_count"] for f in files),
    }

@app.get("/api/v1/text/{task_id}/download")
def download_job_text(task_id: str, token: str = None, db: Session = Depends(get_db)):
    """Whole job as a plain .txt file."""
    user = _user_from_token(token, db)
    job = _require_job(task_id, user, db)
    files = _extract_job_text(job)

    chunks = []
    for f in files:
        chunks.append(f"===== {f['filename']} =====")
        for p in f["pages"]:
            chunks.append(f"\n--- Page {p['page'] + 1} ---\n{p['text']}")
        chunks.append("")

    return Response(
        content="\n".join(chunks),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{task_id[:8]}_text.txt"'},
    )

@app.get("/api/v1/page-thumb/{task_id}/{page}")
def get_page_thumb(
    request: Request,
    task_id: str,
    page: int,
    filename: str,
    side: str = "after",
    token: str = None,
    db: Session = Depends(get_db)
):
    """One rendered page as PNG, so the browser can lazy-load thumbnails individually."""
    user = _user_from_token(token, db)
    job = _require_job(task_id, user, db)

    input_folder, output_folder = _session_folders(job)
    folder = input_folder if side == "before" else output_folder
    pdf_path = _safe_pdf_path(folder, filename)

    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="File no longer available (cleaned up after 24h)")

    # Validate against the PDF's mtime: rotating a page rewrites the file, so the ETag
    # changes and the browser re-fetches instead of showing a stale thumbnail.
    stat = os.stat(pdf_path)
    etag = f'W/"{page}-{side}-{int(stat.st_mtime)}-{stat.st_size}"'
    cache_headers = {"ETag": etag, "Cache-Control": "private, max-age=0, must-revalidate"}

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    try:
        doc = fitz.open(pdf_path)
        if page < 0 or page >= doc.page_count:
            doc.close()
            raise HTTPException(status_code=404, detail="Page out of range")
        pix = doc.load_page(page).get_pixmap(matrix=fitz.Matrix(0.4, 0.4))
        img_bytes = pix.tobytes("png")
        doc.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to render page: {e}")

    return Response(content=img_bytes, media_type="image/png", headers=cache_headers)

class ReviewApproveRequest(BaseModel):
    filename: str
    page: int

@app.post("/api/v1/review/{task_id}/approve")
def approve_page(
    task_id: str,
    req: ReviewApproveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Accept the AI's decision for a single page."""
    job, _ = _require_job_result(task_id, current_user, db)
    reviewed = _load_reviewed(job)
    reviewed.add(_review_key(req.filename, req.page))
    _save_reviewed(job, reviewed)
    db.commit()
    return {"message": "Page approved", "reviewed": len(reviewed)}

class ReviewBulkRequest(BaseModel):
    action: str            # "accept_all" | "rotate_all"
    angle: int = 0         # used by rotate_all
    filename: Optional[str] = None   # limit to one file, otherwise whole job

@app.post("/api/v1/review/{task_id}/bulk")
def review_bulk(
    task_id: str,
    req: ReviewBulkRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    One decision for many pages. Built for the case where every page came back low
    confidence (image-only scans), where per-page review is useless.
    """
    if req.action not in ("accept_all", "rotate_all"):
        raise HTTPException(status_code=400, detail="Unknown action")
    if req.action == "rotate_all" and req.angle % 90 != 0:
        raise HTTPException(status_code=400, detail="Angle must be a multiple of 90")

    job, result = _require_job_result(task_id, current_user, db)
    page_details = result.get("page_details", {})
    _, output_folder = _job_folders(job, result)

    targets = [req.filename] if req.filename else list(page_details.keys())
    reviewed = _load_reviewed(job)
    pages_touched = 0

    for filename in targets:
        pages = page_details.get(filename) or {}
        if req.action == "rotate_all" and req.angle % 360 != 0:
            pdf_path = _safe_pdf_path(output_folder, filename)
            if not os.path.exists(pdf_path):
                continue
            try:
                doc = fitz.open(pdf_path)
                for page_num in range(doc.page_count):
                    pdf_page = doc.load_page(page_num)
                    pdf_page.set_rotation((pdf_page.rotation + req.angle) % 360)
                doc.saveIncr()
                doc.close()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to rotate {filename}: {e}")

        for page_str in pages.keys():
            try:
                reviewed.add(_review_key(filename, int(page_str)))
                pages_touched += 1
            except (TypeError, ValueError):
                continue

    _save_reviewed(job, reviewed)
    db.commit()
    return {"message": f"{req.action} applied", "pages": pages_touched, "reviewed": len(reviewed)}

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

@app.websocket("/ws/progress/{task_id}")
async def websocket_endpoint(websocket: WebSocket, task_id: str):
    await websocket.accept()
    
    redis = await aioredis.from_url(REDIS_URL)
    pubsub = redis.pubsub()
    channel_name = f"task_progress_{task_id}"
    await pubsub.subscribe(channel_name)
    
    # Without these bounds the loop runs forever when a job never reports a terminal
    # state, which keeps the socket open, pins a Redis connection, and blocks uvicorn
    # from shutting down or reloading.
    MAX_SESSION_SECONDS = 6 * 60 * 60
    IDLE_TIMEOUT_SECONDS = 15 * 60

    started = asyncio.get_event_loop().time()
    last_message = started

    try:
        while True:
            now = asyncio.get_event_loop().time()
            if now - started > MAX_SESSION_SECONDS or now - last_message > IDLE_TIMEOUT_SECONDS:
                await websocket.send_text(json.dumps({
                    "task_id": task_id,
                    "status": "DISCONNECTED",
                    "reason": "No progress received - reconnect or check job status.",
                }))
                break

            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message:
                last_message = now
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
