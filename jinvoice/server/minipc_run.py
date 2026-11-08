"""Send one task to the mini PC Hermes (/watchai API) and print its result.
  python minipc_run.py task.txt [timeout_s]
"""
import json, re, sys, time, urllib.request

def hermes(method, path, body=None):
    props = open(r"E:\app_make4\JinhoWatchAI\local.properties", encoding="utf-8").read()
    key = re.search(r"^hermes\.key\s*=\s*(.+)$", props, re.M).group(1).strip()
    r = urllib.request.Request("https://imist.co.kr/watchai" + path, method=method,
                               data=json.dumps(body).encode() if body else None)
    r.add_header("Authorization", "Bearer " + key); r.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(r, timeout=60).read())

task = open(sys.argv[1], encoding="utf-8").read()
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 900
rid = hermes("POST", "/v1/runs", {"input": task, "instructions": "Windows mini PC. Do it, verify, report in Korean. Never print secrets."})["run_id"]
print("run", rid, flush=True)
end = time.time() + limit
while time.time() < end:
    r = hermes("GET", "/v1/runs/" + rid)
    if r.get("status") not in ("started", "running", "queued", "in_progress"):
        print(r.get("status")); print(r.get("output")); break
    time.sleep(10)
else:
    print("still running:", rid)
