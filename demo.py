"""Cliente falso (EMT_DEMO=1) que imita las respuestas de la EMT para probar la interfaz."""
import time


class DemoClient:
    def __init__(self, *_, **__):
        self.t0 = time.time()

    def arrivals(self, stop_id):
        el = int(time.time() - self.t0)
        lines = [("27", "PLAZA CASTILLA", 240), ("27", "PLAZA CASTILLA", 900), ("44", "CALLAO", 95), ("C1", "CIRCULAR", 2000)]
        buses = []
        for line, dest, base in lines:
            eta = (base - el) % 1500
            buses.append({"line": line, "destination": dest, "eta": None if eta > 1200 else eta,
                          "distance": eta * 6, "bus": 1000})
        buses.sort(key=lambda b: (b["eta"] is None, b["eta"] or 0))
        return {"stop": str(stop_id), "name": f"Demo parada {stop_id}", "fetched_at": time.time(), "buses": buses}
