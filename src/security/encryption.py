import os
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Secret key should be loaded from .env
# For this skill, we provide a utility to manage it
def get_secret_key():
    key = os.getenv("API_ENCRYPTION_KEY")
    if not key:
        # Fallback for development, in production this MUST be set
        return b'thirty-two-bytes-long-secret-key-!!' 
    return key.encode().ljust(32)[:32]

def encrypt_payload(data: str) -> str:
    """Encrypts a string payload using AES-256-GCM."""
    aesgcm = AESGCM(get_secret_key())
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, data.encode(), None)
    return base64.b64encode(nonce + ct).decode('utf-8')

def decrypt_payload(encrypted_data: str) -> str:
    """Decrypts an AES-256-GCM encrypted payload."""
    data = base64.b64decode(encrypted_data)
    nonce = data[:12]
    ct = data[12:]
    aesgcm = AESGCM(get_secret_key())
    return aesgcm.decrypt(nonce, ct, None).decode('utf-8')
