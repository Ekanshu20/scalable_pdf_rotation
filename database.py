import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Enum, ForeignKey, text
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime
import enum

Base = declarative_base()

class JobStatus(enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    folders = relationship("Folder", back_populates="owner")
    jobs = relationship("Job", back_populates="owner")

class Folder(Base):
    __tablename__ = "folders"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    owner = relationship("User", back_populates="folders")
    files = relationship("FileRecord", back_populates="folder")

class FileRecord(Base):
    __tablename__ = "files"
    id = Column(Integer, primary_key=True, index=True)
    folder_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    filename = Column(String)
    file_path = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

    folder = relationship("Folder", back_populates="files")

class Job(Base):
    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(String, unique=True, index=True)
    session_id = Column(String, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    folder_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    status = Column(String, default=JobStatus.PENDING.value)
    total_files = Column(Integer, default=0)
    total_pages = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    error_message = Column(String, nullable=True)
    # JSON list of "filename::page" keys a human has signed off on
    reviewed_pages = Column(String, nullable=True)

    owner = relationship("User", back_populates="jobs")

# Ensure the DB is saved in /app/tmp so it persists
DB_PATH = os.getenv("DB_PATH", "sqlite:////app/tmp/jobs.db")
engine = create_engine(DB_PATH, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()

# Columns added after the DB was already deployed. create_all() only creates
# missing tables, it never alters existing ones, so add these by hand.
_LATER_COLUMNS = [
    ("files", "user_id", "INTEGER"),
    ("jobs", "reviewed_pages", "TEXT"),
]

def _add_missing_columns():
    if engine.dialect.name != "sqlite":
        return
    with engine.connect() as conn:
        for table, column, coltype in _LATER_COLUMNS:
            cols = [row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))]
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))
        conn.commit()
