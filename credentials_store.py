"""Almacenamiento de credenciales OAuth de YouTube.

Lee y escribe las credenciales en formato JSON (`Credentials.to_json()`), el
formato oficial y portable de google-auth. Mantiene retrocompatibilidad con el
formato `pickle` heredado: si el archivo en disco es un pickle antiguo se carga
igual y, en el siguiente guardado, se reescribe como JSON de forma transparente.

Evitar `pickle` para credenciales elimina el riesgo de deserializacion
arbitraria y la fragilidad entre versiones de librerias.
"""

import json
import logging
import os
import pickle

from google.oauth2.credentials import Credentials

log = logging.getLogger("credentials")


def load_credentials(path: str):
    """Carga credenciales desde JSON (preferido) o pickle heredado.

    Devuelve un objeto Credentials o None si el archivo no existe o es ilegible.
    """
    if not path or not os.path.exists(path):
        return None

    # Formato preferido: JSON de google-auth.
    try:
        with open(path, "r", encoding="utf-8") as fh:
            info = json.load(fh)
        return Credentials.from_authorized_user_info(info)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        pass  # No es JSON valido; intentar pickle heredado.
    except Exception as exc:  # pragma: no cover - defensivo
        log.warning("No se pudo cargar credenciales JSON desde %s: %s", path, exc)

    # Retrocompatibilidad: pickle heredado.
    try:
        with open(path, "rb") as fh:
            credentials = pickle.load(fh)
        log.info("Credenciales en formato pickle heredado; se migraran a JSON al guardar.")
        return credentials
    except Exception as exc:
        log.warning("No se pudo cargar credenciales heredadas desde %s: %s", path, exc)
        return None


def save_credentials(credentials, path: str):
    """Guarda credenciales como JSON de forma atomica con permisos 0600."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.isdir(path):
        raise RuntimeError(f"{path} es un directorio; revisa el bind mount de Docker")

    payload = credentials.to_json()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
