#!/usr/bin/env python3
"""
Backend de Cava Visualizer Desklet
Lee el output de cava y lo escribe a /tmp/cava_data.json
para que el desklet pueda leerlo.
"""

import subprocess
import json
import os
import signal
import sys
import time

CAVA_CONFIG = os.path.expanduser("~/.config/cava-desklet/cava.conf")
DATA_FILE = "/tmp/cava_data.json"
BARS = 20

def write_data(values):
    try:
        with open(DATA_FILE, "w") as f:
            json.dump({"bars": values, "ts": time.time()}, f)
    except:
        pass

def run():
    os.makedirs(os.path.dirname(CAVA_CONFIG), exist_ok=True)

    config = f"""
[general]
bars = {BARS}
framerate = 30
autosens = 1
overshoot = 10
lower_cutoff_freq = 50
higher_cutoff_freq = 10000

[output]
method = raw
raw_target = /dev/stdout
data_format = binary
channels = mono
bit_format = 8bit

[smoothing]
monstercat = 1
waves = 0
noise_reduction = 0.77
"""
    with open(CAVA_CONFIG, "w") as f:
        f.write(config)

    proc = subprocess.Popen(
        ["cava", "-p", CAVA_CONFIG],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL
    )

    def cleanup(sig, frame):
        proc.terminate()
        try:
            os.remove(DATA_FILE)
        except:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    try:
        while True:
            raw = proc.stdout.read(BARS)
            if not raw or len(raw) < BARS:
                break
            values = [b / 255.0 for b in raw]
            write_data(values)
    except:
        pass
    finally:
        proc.terminate()

if __name__ == "__main__":
    run()
