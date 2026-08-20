import os
import shutil
import uuid
import zipfile
import json
import base64
import fitz
import asyncio
from typing import List
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from celery.result import AsyncResult
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import redis.asyncio as aioredis

from worker import app as celery_app, process_pdf_rotation
from database import init_db, SessionLocal, Job, JobStatus

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
    return FileResponse("/app/static/index.html")

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
    use_gpu: bool = Form(True)
):
    """
    Handles multi-file and directory uploads from the web UI.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")

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
            except Exception:
                pass
                
            valid_pdf_count += 1
                
    if valid_pdf_count == 0:
         raise HTTPException(status_code=400, detail="No valid PDF files found.")

    # Dispatch to Celery
    task = process_pdf_rotation.delay(
        input_folder,
        output_folder,
        use_gpu,
        gpu_mem=1500,
        num_workers=1
    )
    
    # Record job in database
    db = SessionLocal()
    try:
        new_job = Job(
            task_id=task.id,
            session_id=session_id,
            total_files=valid_pdf_count,
            total_pages=total_pages_count,
            status=JobStatus.PROCESSING.value
        )
        db.add(new_job)
        db.commit()
    finally:
        db.close()
    
    return {
        "message": "Files uploaded and job submitted",
        "task_id": task.id,
        "session_id": session_id,
        "total_files": valid_pdf_count,
        "total_pages": total_pages_count
    }

@app.get("/api/v1/history")
async def get_history():
    db = SessionLocal()
    try:
        jobs = db.query(Job).order_by(Job.created_at.desc()).limit(10).all()
        
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
        
        return [{"task_id": j.task_id, "status": j.status, "total_files": j.total_files, "created_at": j.created_at.isoformat()} for j in jobs]
    finally:
        db.close()

@app.get("/api/v1/status/{task_id}")
async def get_status(task_id: str):
    task_result = AsyncResult(task_id, app=celery_app)
    response = {"task_id": task_id, "status": task_result.status}
    
    db = SessionLocal()
    try:
        job = db.query(Job).filter(Job.task_id == task_id).first()
        
        if task_result.status == 'SUCCESS':
            response["result"] = task_result.result
            if job and job.status != JobStatus.SUCCESS.value:
                job.status = JobStatus.SUCCESS.value
                job.completed_at = datetime.utcnow()
                db.commit()
        elif task_result.status == 'FAILED':
            response["error"] = str(task_result.result)
            if job and job.status != JobStatus.FAILED.value:
                job.status = JobStatus.FAILED.value
                job.error_message = str(task_result.result)
                job.completed_at = datetime.utcnow()
                db.commit()
        elif task_result.status == 'PROCESSING':
            response["details"] = task_result.info
            if job and job.status != JobStatus.PROCESSING.value:
                job.status = JobStatus.PROCESSING.value
                db.commit()
    finally:
        db.close()
        
    return response

@app.get("/api/v1/preview/{task_id}")
async def get_preview(task_id: str):
    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    output_folder = task_result.result.get("output_folder")
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    files = [f for f in os.listdir(output_folder) if f.endswith('.pdf')]
    if not files:
        raise HTTPException(status_code=404, detail="No processed PDFs found.")
        
    # Get first PDF
    first_pdf_path = os.path.join(output_folder, files[0])
    
    # Generate thumbnail
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
async def download_results(task_id: str):
    task_result = AsyncResult(task_id, app=celery_app)
    if task_result.status != 'SUCCESS':
         raise HTTPException(status_code=400, detail="Task not complete yet.")
         
    output_folder = task_result.result.get("output_folder")
    if not output_folder or not os.path.exists(output_folder):
         raise HTTPException(status_code=404, detail="Output folder not found.")
         
    files = [f for f in os.listdir(output_folder) if f.endswith('.pdf')]
    if not files:
        raise HTTPException(status_code=404, detail="No processed PDFs found.")
        
    if len(files) == 1:
        # Return single PDF
        file_path = os.path.join(output_folder, files[0])
        return FileResponse(file_path, media_type="application/pdf", filename=files[0])
    else:
        # Return Zip
        zip_filename = f"{task_id}.zip"
        zip_filepath = os.path.join(BASE_TMP_DIR, zip_filename)
        with zipfile.ZipFile(zip_filepath, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, fs in os.walk(output_folder):
                for file in fs:
                    if file.endswith('.pdf'):
                        file_path = os.path.join(root, file)
                        zipf.write(file_path, arcname=file)
                        
        return FileResponse(zip_filepath, media_type="application/zip", filename="rotated_pdfs.zip")

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
            # We use a small timeout so we can periodically check if client disconnected
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message:
                data = message['data'].decode('utf-8')
                await websocket.send_text(data)
                
                # Check if we should close
                msg_dict = json.loads(data)
                if msg_dict.get('status') in ['SUCCESS', 'FAILED']:
                    break
            
            # small sleep to prevent busy loop if timeout fails for some reason
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await pubsub.unsubscribe(channel_name)
        await redis.close()
