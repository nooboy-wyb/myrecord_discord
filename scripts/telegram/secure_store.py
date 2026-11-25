import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def transform(data, decrypt=False):
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is required for Telegram credentials")
    buffer = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    destination = DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        operation = crypt32.CryptUnprotectData
        operation.argtypes = [ctypes.POINTER(DataBlob), ctypes.POINTER(ctypes.c_void_p),
                              ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                              wintypes.DWORD, ctypes.POINTER(DataBlob)]
        description = ctypes.c_void_p()
        arguments = [ctypes.byref(source), ctypes.byref(description)]
    else:
        operation = crypt32.CryptProtectData
        operation.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_wchar_p,
                              ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                              wintypes.DWORD, ctypes.POINTER(DataBlob)]
        description = None
        arguments = [ctypes.byref(source), "Muse Telegram"]
    operation.restype = wintypes.BOOL
    try:
        success = operation(*arguments, None, None, None, 1, ctypes.byref(destination))
        if not success:
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.string_at(destination.data, destination.size)
    finally:
        if destination.data:
            kernel32.LocalFree(destination.data)
        if decrypt and description.value:
            kernel32.LocalFree(description)


def read_secret(file):
    return json.loads(transform(Path(file).read_bytes(), decrypt=True).decode("utf-8"))


def write_secret(file, value):
    target = Path(file)
    target.parent.mkdir(parents=True, exist_ok=True)
    encrypted = transform(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_bytes(encrypted)
    temporary.replace(target)
