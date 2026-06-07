import urllib.request, json, sys, os

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')

def sb_get(path):
    req = urllib.request.Request(SUPABASE_URL + path)
    req.add_header('apikey', SUPABASE_KEY)
    req.add_header('Authorization', 'Bearer ' + SUPABASE_KEY)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode()
    except Exception as e:
        print(f'[error] {e}', file=sys.stderr)
        return '[]'

def sb_patch(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(SUPABASE_URL + path, data=body, method='PATCH')
    req.add_header('apikey', SUPABASE_KEY)
    req.add_header('Authorization', 'Bearer ' + SUPABASE_KEY)
    req.add_header('Content-Type', 'application/json')
    req.add_header('Prefer', 'return=minimal')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return True
    except Exception as e:
        print(f'[error] {e}', file=sys.stderr)
        return False

cmd = sys.argv[1] if len(sys.argv) > 1 else ''

if cmd == 'get_pending':
    print(sb_get('/rest/v1/sprint_queue?status=eq.pending&order=priority.asc,sprint_number.asc&limit=1'))
elif cmd == 'mark_inprogress':
    sb_patch(f'/rest/v1/sprint_queue?id=eq.{sys.argv[2]}', {'status': 'in_progress'})
elif cmd == 'mark_done':
    sb_patch(f'/rest/v1/sprint_queue?id=eq.{sys.argv[2]}', {'status': 'done'})
elif cmd == 'mark_failed':
    sb_patch(f'/rest/v1/sprint_queue?id=eq.{sys.argv[2]}', {'status': 'failed'})
