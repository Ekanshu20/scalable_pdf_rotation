# Scalable AI PDF Rotation 📄🔄

Welcome to the **Scalable AI PDF Rotation** project! 

This repository contains a powerful, machine-learning-driven backend system and a modern UI designed to automatically detect the orientation of text inside PDF files and rotate the pages so they are perfectly upright. 

It is built for **scale** and **performance**, utilizing a modern microservice architecture that offloads heavy Machine Learning processing to background workers with GPU support. It features real-time progress updates via WebSockets and an automated background cleanup service.

---

## ✨ Features

- **User Authentication**: Secure user registration and JWT-based login system to manage personal workspaces.
- **Folder Management**: Organize your processed PDFs into custom folders. Fully supports renaming, downloading ZIPs, merging PDFs, and individually deleting or batch-deleting multiple PDF files.
- **Visual Comparison & Manual Override**: Side-by-side before and after comparison of processed pages, with the ability to manually override and fix rotation predictions.
- **Batch Processing**: Upload multiple PDFs at once and download the processed results as a convenient ZIP file.
- **Modern Web UI**: Beautiful dark/light mode interface with drag-and-drop support.
- **Real-Time Progress**: Watch the progress bar fill up smoothly thanks to WebSocket integration with Redis Pub/Sub.
- **ETA Predictor**: Instantly calculates and displays an estimated time remaining based on the total number of pages and your hardware.
- **Job History**: Backed by SQLite, easily access and re-download your recent processing jobs.
- **Auto-Cleanup**: A Celery Beat scheduler wakes up every hour to automatically delete old temporary files and keep your disk space safe.
- **GPU Acceleration**: Built-in support for CUDA to process massive PDFs in seconds.

---

## 🏗️ Architecture Overview

To handle large PDFs without crashing or timing out, this project is split into four main services using **Docker Compose**:

1. **FastAPI Web Server (`api`)**: 
   A lightweight web server that serves the UI and accepts your PDF uploads. It instantly hands them off to the background queue and manages WebSocket connections to stream progress to the frontend.
2. **Redis Message Broker (`redis`)**:
   The "middleman". It holds the queue of jobs waiting to be processed and handles the Pub/Sub messaging for real-time progress bars.
3. **Celery GPU Worker (`worker`)**:
   The heavy lifter. This background worker listens to Redis for new jobs. When it gets one, it uses **PaddleOCR** and **PyMuPDF** to visually analyze the text on every page of the PDF, determine its orientation (0, 90, 180, or 270 degrees), and save a perfectly rotated version.
4. **Celery Beat (`celery-beat`)**:
   The janitor. Runs in the background on a schedule to clear out the `/app/tmp` folder of any processed files older than 24 hours.

---

## 🚀 How to Run the Project

The easiest way to run this entire system is using **Docker**. Docker automatically sets up the databases, installs the complex ML libraries, and links everything together.

### Prerequisites
1. **Docker Desktop** installed on your computer.
2. (Optional but recommended) An NVIDIA GPU for much faster processing. If using Linux, ensure you have the `nvidia-container-toolkit` installed.

### Step-by-Step Instructions

1. **Clone the repository** and open your terminal in the project folder.
2. **Build and start the services** by running this single command:
   ```bash
   docker-compose up -d --build
   ```
   *(Note: The first time you run this, it will take several minutes to download the heavy Machine Learning base images. Subsequent runs will take just seconds).*

3. **Wait for the system to boot**. The services will start in the background.

4. **Open the Web UI**:
   Navigate to `http://localhost:8000` in your browser. You can now drag and drop PDFs, toggle GPU acceleration, and watch the AI rotate them in real-time!

---

## 🛠️ Project Structure

* **`main.py`**: The fully-featured FastAPI application. Provides the UI, authentication (`/api/v1/auth/*`), folder management (`/api/v1/folders`), core endpoints (`/api/v1/upload`, `/api/v1/history`, `/api/v1/compare`, `/api/v1/override`), and WebSocket progress streaming (`/ws/progress`).
* **`worker.py`**: The Celery worker configuration. Contains the background ML execution task and the cleanup task.
* **`scalable_pdf_rotation.py`**: The core ML logic that analyzes bounding boxes and text orientation using PaddleOCR.
* **`database.py`**: SQLAlchemy configuration for the SQLite job history tracking.
* **`docker-compose.yml`**: The blueprint that tells Docker how to run the API, Redis, Worker, and Beat scheduler together with shared volumes.
* **`Dockerfile.api` & `Dockerfile.worker`**: The instructions for building the Docker images.
* **`static/`**: Contains the HTML, CSS, and JS for the frontend UI.
* **`requirements_docker.txt`**: Python dependencies needed to run the core ML environment.
