# Build context: repository root (see docker-compose.yml and CI).

FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install Python and essential build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/lib/x86_64-linux-gnu/libcudnn.so.8 /usr/lib/x86_64-linux-gnu/libcudnn.so \
    && ln -s /usr/local/cuda-11.8/targets/x86_64-linux/lib/libcublas.so.11 /usr/local/cuda-11.8/targets/x86_64-linux/lib/libcublas.so

# Set working directory
WORKDIR /app

# Upgrade pip
RUN python3 -m pip install --upgrade pip

# Install Python dependencies
COPY backend/requirements/worker.txt requirements.txt
RUN python3 -m pip install -r requirements.txt

# Only the backend package; the frontend and archive stay out of the image
COPY backend/app app

# Set environment variables for GPU usage
ENV CUDA_VISIBLE_DEVICES=0
ENV LD_LIBRARY_PATH=/usr/local/cuda-11.8/targets/x86_64-linux/lib/:/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH

# Run Celery worker using the solo pool so it can spawn its own child processes for ML parallelization
CMD ["celery", "-A", "app.worker", "worker", "--loglevel=info", "--pool=solo"]
