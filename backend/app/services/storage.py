"""Object storage: local filesystem for development, S3-compatible (MinIO) for production."""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from ..config import get_settings

ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAGIC = {b"\xff\xd8\xff": "image/jpeg", b"\x89PNG\r\n\x1a\n": "image/png", b"RIFF": "image/webp"}


def sniff(data: bytes) -> str | None:
    for sig, ctype in MAGIC.items():
        if data.startswith(sig):
            if ctype == "image/webp" and data[8:12] != b"WEBP":
                continue
            return ctype
    return None


class Storage:
    def put(self, data: bytes, content_type: str, prefix: str) -> tuple[str, str]:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError


class LocalStorage(Storage):
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("invalid key")
        return p

    def put(self, data, content_type, prefix):
        key = f"{prefix}/{uuid.uuid4().hex}{ALLOWED_TYPES.get(content_type, '')}"
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return key, hashlib.sha256(data).hexdigest()

    def get(self, key):
        return self._path(key).read_bytes()


class S3Storage(Storage):
    def __init__(self):
        import boto3

        s = get_settings()
        self.bucket = s.s3_bucket
        self.client = boto3.client("s3", endpoint_url=s.s3_endpoint_url, aws_access_key_id=s.s3_access_key,
                                   aws_secret_access_key=s.s3_secret_key)
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except Exception:
            self.client.create_bucket(Bucket=self.bucket)

    def put(self, data, content_type, prefix):
        key = f"{prefix}/{uuid.uuid4().hex}{ALLOWED_TYPES.get(content_type, '')}"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                               ServerSideEncryption="AES256")
        return key, hashlib.sha256(data).hexdigest()

    def get(self, key):
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        s = get_settings()
        _storage = S3Storage() if s.storage_backend == "s3" else LocalStorage(s.storage_local_dir)
    return _storage
