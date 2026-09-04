import os
import subprocess


def verify():
    # Simulate the logic added to download_vod.py
    local_bin = os.path.join(os.getcwd(), "bin")
    if os.path.exists(os.path.join(local_bin, "ffmpeg.exe")):
        print(f"Injecting path: {local_bin}")
        os.environ["PATH"] = local_bin + os.pathsep + os.environ["PATH"]

    try:
        # Try running ffmpeg
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        if result.returncode == 0:
            print("FFmpeg is installed and working.")
            print(result.stdout.splitlines()[0])
        else:
            print("FFmpeg returned an error code.")
    except FileNotFoundError:
        print("FFmpeg was not found.")


if __name__ == "__main__":
    verify()
