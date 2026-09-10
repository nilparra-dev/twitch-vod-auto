import os
import shutil
import urllib.request
import zipfile

from tqdm import tqdm

FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
ZIP_FILENAME = "ffmpeg.zip"
EXTRACT_DIR = "ffmpeg_temp"
BIN_DIR = "bin"


class DownloadProgressBar(tqdm):
    def update_to(self, b=1, bsize=1, tsize=None):
        if tsize is not None:
            self.total = tsize
        self.update(b * bsize - self.n)


def download_ffmpeg():
    print(f"Downloading FFMPEG from {FFMPEG_URL}...")
    with DownloadProgressBar(unit="B", unit_scale=True, miniters=1, desc=ZIP_FILENAME) as t:
        urllib.request.urlretrieve(FFMPEG_URL, filename=ZIP_FILENAME, reporthook=t.update_to)
    print("Download complete.")


def extract_and_install():
    print("Extracting FFMPEG...")
    if not os.path.exists(EXTRACT_DIR):
        os.makedirs(EXTRACT_DIR)

    with zipfile.ZipFile(ZIP_FILENAME, "r") as zip_ref:
        zip_ref.extractall(EXTRACT_DIR)

    # Find the bin folder inside the extracted structure
    ffmpeg_exe = None
    ffprobe_exe = None

    for root, _dirs, files in os.walk(EXTRACT_DIR):
        if "ffmpeg.exe" in files:
            ffmpeg_exe = os.path.join(root, "ffmpeg.exe")
        if "ffprobe.exe" in files:
            ffprobe_exe = os.path.join(root, "ffprobe.exe")

    if not ffmpeg_exe or not ffprobe_exe:
        print("Could not find ffmpeg.exe or ffprobe.exe in the downloaded archive.")
        return

    if not os.path.exists(BIN_DIR):
        os.makedirs(BIN_DIR)

    destination_ffmpeg = os.path.join(BIN_DIR, "ffmpeg.exe")
    destination_ffprobe = os.path.join(BIN_DIR, "ffprobe.exe")

    shutil.move(ffmpeg_exe, destination_ffmpeg)
    shutil.move(ffprobe_exe, destination_ffprobe)

    print(f"Installed FFmpeg at {os.path.abspath(destination_ffmpeg)}")

    # Cleanup
    print("Cleaning up temporary files...")
    os.remove(ZIP_FILENAME)
    shutil.rmtree(EXTRACT_DIR)
    print("Done!")


if __name__ == "__main__":
    if os.path.exists(os.path.join(BIN_DIR, "ffmpeg.exe")):
        print("FFmpeg is already installed in ./bin/.")
    else:
        download_ffmpeg()
        extract_and_install()
