"""Store YouTube OAuth credentials.

Read and write credentials in google-auth's portable JSON format. Legacy pickle
files remain readable and are converted to JSON on the next save.

Avoiding pickle for new writes removes arbitrary deserialization risk and
reduces compatibility problems between library versions.
"""

import errno
import json
import logging
import os
import pickle

from google.oauth2.credentials import Credentials

log = logging.getLogger("credentials")


def load_credentials(path: str):
    """Load credentials from JSON or a legacy pickle file.

    Return None when the file does not exist or cannot be read.
    """
    if not path or not os.path.exists(path):
        return None

    # Preferred format: google-auth JSON.
    try:
        with open(path, encoding="utf-8") as fh:
            info = json.load(fh)
        return Credentials.from_authorized_user_info(info)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        pass  # Not valid JSON; try the legacy pickle format.
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("Could not load JSON credentials from %s: %s", path, exc)

    # Backward compatibility for legacy pickle files.
    try:
        with open(path, "rb") as fh:
            credentials = pickle.load(fh)
        log.info("Loaded legacy pickle credentials; the next save will convert them to JSON.")
        return credentials
    except Exception as exc:
        log.warning("Could not load legacy credentials from %s: %s", path, exc)
        return None


def save_credentials(credentials, path: str):
    """Save credentials as JSON atomically with 0600 permissions."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.isdir(path):
        raise RuntimeError(f"{path} is a directory; check the Docker bind mount")

    payload = credentials.to_json()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())

    try:
        os.replace(tmp_path, path)
    except OSError as exc:
        # A single-file Docker bind mount returns EBUSY when replaced. EXDEV or
        # EINVAL can occur when the temporary file and destination use different
        # file systems. Fall back to an in-place write in those cases.
        if exc.errno not in (errno.EBUSY, errno.EXDEV, errno.EINVAL):
            raise
        log.warning(
            "Atomic rename unavailable (%s); writing credentials in place at %s.",
            errno.errorcode.get(exc.errno, exc.errno),
            path,
        )
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
