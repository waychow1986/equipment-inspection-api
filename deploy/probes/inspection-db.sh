#!/usr/bin/env bash
# 探测 inspection-db（PostgreSQL）：可达性、认证，以及 docs/dependencies.json 中声明的约束
#   server-version、schema-privileges（各报告一次）。
# 只使用平台探测环境提供的 bash / timeout / python3；不输出任何机密。
# 输入：AIDH_DEP_INSPECTION_DB_{ADDRESS,DATABASE,USERNAME,PASSWORD,SSLMODE}
# 输出：$AIDH_PROBE_RESULT（JSON：reachable、authenticated、results[]）
set -uo pipefail

: "${AIDH_PROBE_RESULT:?AIDH_PROBE_RESULT is required}"

timeout 60 python3 -I - <<'PY'
import base64, hashlib, hmac, json, os, socket, ssl, struct

RESULT_PATH = os.environ["AIDH_PROBE_RESULT"]
CONSTRAINTS = ["server-version", "schema-privileges"]
result = {"reachable": False, "authenticated": False, "results": []}


def finish(evidence_by_name=None, satisfied_by_name=None):
    evidence_by_name = evidence_by_name or {}
    satisfied_by_name = satisfied_by_name or {}
    result["results"] = [
        {
            "name": n,
            "status": "satisfied" if satisfied_by_name.get(n) else "unsatisfied",
            "evidence": evidence_by_name.get(n, "not evaluated"),
        }
        for n in CONSTRAINTS
    ]
    with open(RESULT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    raise SystemExit(0)


def env(name, default=None):
    v = os.environ.get("AIDH_DEP_INSPECTION_DB_" + name, default)
    return v if v not in (None, "") else default


address = env("ADDRESS")
database = env("DATABASE")
username = env("USERNAME")
password = env("PASSWORD", "")
sslmode = (env("SSLMODE", "disable") or "disable").lower()

if not address or not database or not username:
    finish({n: "missing connection fields (address/database/username)" for n in CONSTRAINTS})

host, _, port = address.rpartition(":")
host = host.strip("[]")
try:
    port = int(port)
except ValueError:
    finish({n: "address is not host:port" for n in CONSTRAINTS})


class PgError(Exception):
    def __init__(self, fields):
        self.code = fields.get("C", "")
        super().__init__(self.code)


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("connection closed")
        buf += chunk
    return buf


def read_msg(sock):
    head = recv_exact(sock, 5)
    typ, length = head[:1], struct.unpack("!I", head[1:])[0]
    return typ, recv_exact(sock, length - 4)


def send_msg(sock, typ, payload):
    sock.sendall(typ + struct.pack("!I", len(payload) + 4) + payload)


def parse_fields(payload):
    fields = {}
    for part in payload.split(b"\x00"):
        if part:
            fields[chr(part[0])] = part[1:].decode("utf-8", "replace")
    return fields


# ---- connect -------------------------------------------------------------
try:
    sock = socket.create_connection((host, port), timeout=10)
    sock.settimeout(15)
except OSError as e:
    finish({n: "tcp connect failed: " + type(e).__name__ for n in CONSTRAINTS})

try:
    if sslmode in ("require", "verify-ca", "verify-full", "prefer"):
        sock.sendall(struct.pack("!II", 8, 80877103))
        answer = recv_exact(sock, 1)
        if answer == b"S":
            ctx = ssl.create_default_context()
            if sslmode in ("require", "prefer"):
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            elif sslmode == "verify-ca":
                ctx.check_hostname = False
            sock = ctx.wrap_socket(sock, server_hostname=host)
        elif sslmode != "prefer":
            result["reachable"] = True
            finish({n: "server refused TLS while sslmode=" + sslmode for n in CONSTRAINTS})

    params = b"user\x00" + username.encode() + b"\x00database\x00" + database.encode() + b"\x00\x00"
    startup = struct.pack("!I", 196608) + params
    sock.sendall(struct.pack("!I", len(startup) + 4) + startup)
    result["reachable"] = True

    # ---- authentication ----------------------------------------------------
    nonce = scram_state = None
    while True:
        typ, payload = read_msg(sock)
        if typ == b"E":
            raise PgError(parse_fields(payload))
        if typ != b"R":
            if typ in (b"S", b"K"):
                break
            continue
        code = struct.unpack("!I", payload[:4])[0]
        if code == 0:
            break
        if code == 3:  # cleartext
            send_msg(sock, b"p", password.encode() + b"\x00")
        elif code == 5:  # md5
            salt = payload[4:8]
            inner = hashlib.md5(password.encode() + username.encode()).hexdigest().encode()
            send_msg(sock, b"p", b"md5" + hashlib.md5(inner + salt).hexdigest().encode() + b"\x00")
        elif code == 10:  # SASL
            mechs = [m for m in payload[4:].split(b"\x00") if m]
            if b"SCRAM-SHA-256" not in mechs:
                finish({n: "server requires unsupported SASL mechanism" for n in CONSTRAINTS})
            nonce = base64.b64encode(os.urandom(18)).decode()
            first_bare = "n=,r=" + nonce
            msg = ("n,," + first_bare).encode()
            send_msg(sock, b"p", b"SCRAM-SHA-256\x00" + struct.pack("!I", len(msg)) + msg)
            scram_state = {"first_bare": first_bare}
        elif code == 11:  # SASL continue
            server_first = payload[4:].decode()
            attrs = dict(kv.split("=", 1) for kv in server_first.split(","))
            if not attrs["r"].startswith(nonce):
                finish({n: "SCRAM nonce mismatch" for n in CONSTRAINTS})
            salted = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(attrs["s"]), int(attrs["i"]))
            client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
            stored_key = hashlib.sha256(client_key).digest()
            without_proof = "c=biws,r=" + attrs["r"]
            auth_msg = ",".join([scram_state["first_bare"], server_first, without_proof]).encode()
            signature = hmac.new(stored_key, auth_msg, hashlib.sha256).digest()
            proof = bytes(a ^ b for a, b in zip(client_key, signature))
            send_msg(sock, b"p", (without_proof + ",p=" + base64.b64encode(proof).decode()).encode())
        elif code == 12:  # SASL final
            continue
        else:
            finish({n: "unsupported authentication request %d" % code for n in CONSTRAINTS})

    # drain until ReadyForQuery
    while True:
        typ, payload = read_msg(sock)
        if typ == b"E":
            raise PgError(parse_fields(payload))
        if typ == b"Z":
            break
    result["authenticated"] = True

    def query(sql):
        send_msg(sock, b"Q", sql.encode() + b"\x00")
        rows, error = [], None
        while True:
            typ, payload = read_msg(sock)
            if typ == b"D":
                n = struct.unpack("!H", payload[:2])[0]
                off, row = 2, []
                for _ in range(n):
                    ln = struct.unpack("!i", payload[off:off + 4])[0]
                    off += 4
                    if ln < 0:
                        row.append(None)
                    else:
                        row.append(payload[off:off + ln].decode())
                        off += ln
                rows.append(row)
            elif typ == b"E":
                error = parse_fields(payload).get("C", "")
            elif typ == b"Z":
                break
        if error:
            raise PgError({"C": error})
        return rows

    evidence, satisfied = {}, {}

    version_num = int(query("SHOW server_version_num")[0][0])
    satisfied["server-version"] = version_num >= 140000
    evidence["server-version"] = "server_version_num=%d (required >= 140000)" % version_num

    priv = query(
        "SELECT has_database_privilege(current_database(), 'CREATE'), "
        "EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'inspection'), "
        "CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'inspection') "
        "THEN has_schema_privilege('inspection', 'CREATE') AND has_schema_privilege('inspection', 'USAGE') "
        "ELSE false END"
    )[0]
    can_create_db, schema_exists, schema_ok = (v == "t" for v in priv)
    satisfied["schema-privileges"] = schema_ok if schema_exists else can_create_db
    evidence["schema-privileges"] = (
        "database CREATE privilege=%s; schema inspection exists=%s; CREATE+USAGE on schema=%s"
        % (can_create_db, schema_exists, schema_ok)
    )

    try:
        send_msg(sock, b"X", b"")
    except OSError:
        pass
    finish(evidence, satisfied)

except PgError as e:
    # 28P01 invalid_password, 28000 invalid_authorization_specification, 3D000 database does not exist
    finish({n: "server error SQLSTATE " + e.code for n in CONSTRAINTS})
except (OSError, ConnectionError, ssl.SSLError, ValueError, KeyError, struct.error) as e:
    finish({n: "protocol/connection error: " + type(e).__name__ for n in CONSTRAINTS})
PY
rc=$?
if [ ! -s "$AIDH_PROBE_RESULT" ]; then
  printf '{"reachable":false,"authenticated":false,"results":[{"name":"server-version","status":"unsatisfied","evidence":"probe did not complete (exit %s)"},{"name":"schema-privileges","status":"unsatisfied","evidence":"probe did not complete (exit %s)"}]}\n' "$rc" "$rc" > "$AIDH_PROBE_RESULT"
fi
exit 0
