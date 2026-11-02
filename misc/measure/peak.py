# measure-anon.py PROGRAM ARGS...: wall time and peak RssAnon / RssFile of a program, sampled every 10 ms
import re, subprocess, sys, time
start = time.monotonic()
child = subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL)
anon = file = 0
while child.poll() is None:
    try:
        status = open(f"/proc/{child.pid}/status").read()
        anon = max(anon, int(re.search(r"RssAnon:\s+(\d+)", status).group(1)))
        file = max(file, int(re.search(r"RssFile:\s+(\d+)", status).group(1)))
    except (FileNotFoundError, AttributeError, ProcessLookupError):
        pass
    time.sleep(0.01)
print(f"{time.monotonic() - start:.2f} s RssAnon {anon // 1024} MB RssFile {file // 1024} MB exit={child.returncode}")
