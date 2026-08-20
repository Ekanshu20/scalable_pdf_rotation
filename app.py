from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import shutil
import os
import tempfile
from scalable_pdf_rotation import process_pdf_standalone, process_directory

app = FastAPI(title="AI PDF Rotator API")

# Mount the static directory for the frontend
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Enable CORS for local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def serve_index():
    return FileResponse("static/index.html")

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed")

    # Save the uploaded file to a temporary location
    temp_dir = tempfile.mkdtemp()
    input_path = os.path.join(temp_dir, file.filename)
    output_path = os.path.join(temp_dir, f"rotated_{file.filename}")

    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        # Process the single PDF
        process_pdf_standalone(input_path, output_path)
        
        # Ensure the file was actually created
        if not os.path.exists(output_path):
             # If no rotations were needed or error occurred, return original
             output_path = input_path

        # Return the processed file
        return FileResponse(output_path, media_type="application/pdf", filename=f"rotated_{file.filename}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/process_folder")
async def process_folder(input_folder: str = Form(...), output_folder: str = Form(...)):
    if not os.path.exists(input_folder):
        raise HTTPException(status_code=400, detail="Input folder does not exist")
        
    os.makedirs(output_folder, exist_ok=True)
    
    try:
        process_directory(input_folder, output_folder)
        return {"status": "success", "message": f"Successfully processed all PDFs from {input_folder} to {output_folder}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/test_process")
async def test_process():
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        # Run in a thread to avoid blocking the event loop
        await loop.run_in_executor(
            None,
            process_directory,
            "./input",
            "./output"
        )
        return {"status": "success"}
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        return {"status": "error", "detail": str(e), "traceback": tb}

@app.get("/api/kill_worker")
async def kill_worker():
    import os
    os._exit(1)

if __name__ == "__main__":
    import uvicorn
    import multiprocessing
    # Important for Windows multiprocessing when running via Uvicorn programmatically
    multiprocessing.freeze_support()
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
