"""Cliente mínimo de la API MobilityLabs de EMT Madrid."""
import threading
import time
from datetime import date

import requests

BASE = "https://openapi.emtmadrid.es"
NO_ESTIMATE = 999999  # la EMT devuelve esto cuando el bus está a >20 min o sin dato


class EMTError(Exception):
    pass


class EMTClient:
    def __init__(self, client_id, pass_key, cache_seconds=10, email=None, password=None):
        self.client_id = client_id
        self.pass_key = pass_key
        self.email = email
        self.password = password
        self.cache_seconds = cache_seconds
        self._token = None
        self._token_exp = 0
        self._token_secs = 0
        self._cache = {}
        self._lock = threading.Lock()

    # ---- autenticación -------------------------------------------------
    def _login(self):
        # Primero Protected (X-ClientId + passKey de tu app); si falla, Basic (email + contraseña del portal)
        methods = []
        if self.client_id and self.pass_key:
            methods.append(("X-ClientId/passKey", {"X-ClientId": self.client_id, "passKey": self.pass_key}))
        if self.email and self.password:
            methods.append(("email/contraseña", {"email": self.email, "password": self.password}))
        if not methods:
            raise EMTError("Faltan credenciales EMT en .env")
        errors = []
        for how, headers in methods:
            r = requests.get(f"{BASE}/v1/mobilitylabs/user/login/", headers=headers, timeout=15)
            body = r.json()
            if body.get("code") in ("00", "01") and body.get("data"):
                break
            errors.append(f"{how} (code {body.get('code')})")
        else:
            raise EMTError("Login EMT falló con " + " y ".join(errors) +
                           ". Si tu app sigue 'Pendiente de moderación', puede que aún no esté activa.")
        self.login_method = how
        d = body["data"][0]
        self._token = d["accessToken"]
        # renovamos un poco antes de que caduque (en modo email/contraseña la sesión es corta,
        # pero se alarga sola con cada llamada; si caduca igual, el code 80 fuerza un re-login)
        self._token_secs = int(d.get("tokenSecExpiration", 86400))
        self._token_exp = time.time() + max(60, self._token_secs - 60)

    def _token_valid(self):
        if not self._token or time.time() >= self._token_exp:
            self._login()
        return self._token

    # ---- llegadas ------------------------------------------------------
    def arrivals(self, stop_id):
        stop_id = str(int(stop_id))
        with self._lock:
            hit = self._cache.get(stop_id)
            if hit and time.time() - hit[0] < self.cache_seconds:
                return hit[1]
            data = self._fetch_arrivals(stop_id)
            self._cache[stop_id] = (time.time(), data)
            return data

    def _fetch_arrivals(self, stop_id, retry=True):
        token = self._token_valid()
        r = requests.post(
            f"{BASE}/v2/transport/busemtmad/stops/{stop_id}/arrives/",
            headers={"accessToken": token},
            json={
                "cultureInfo": "ES",
                "Text_StopRequired_YN": "Y",
                "Text_EstimationsRequired_YN": "Y",
                "Text_IncidencesRequired_YN": "N",
                "DateTime_Referenced_Incidencies_YYYYMMDD": date.today().strftime("%Y%m%d"),
            },
            timeout=15,
        )
        body = r.json()
        code = body.get("code")
        if code == "80" and retry:  # token caducado
            self._token = None
            return self._fetch_arrivals(stop_id, retry=False)
        if code not in ("00", "01") or not body.get("data"):
            raise EMTError(body.get("description") or f"Error EMT (code {code})")

        self._token_exp = time.time() + max(60, self._token_secs - 60)  # la EMT alarga la sesión con cada uso
        d = body["data"][0]
        info = (d.get("StopInfo") or [{}])[0]
        buses = []
        for a in d.get("Arrive") or []:
            eta = a.get("estimateArrive")
            buses.append({
                "line": str(a.get("line")),
                "destination": a.get("destination"),
                "eta": None if eta is None or eta >= NO_ESTIMATE else int(eta),
                "distance": a.get("DistanceBus"),
                "bus": a.get("bus"),
            })
        buses.sort(key=lambda b: (b["eta"] is None, b["eta"] or 0))
        return {
            "stop": stop_id,
            "name": info.get("stopName") or f"Parada {stop_id}",
            "fetched_at": time.time(),
            "buses": buses,
        }
