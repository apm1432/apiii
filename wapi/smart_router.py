--- /mnt/user-data/uploads/smart_router__2_.py	2026-11-19 10:32:36.763782000 +0000
+++ smart_router.py	2026-11-19 10:44:26.492057140 +0000
@@ -1470,6 +1470,21 @@
 HD503_WINDOW_SECS = int(os.environ.get("HD503_WINDOW_SECS", "300")) # strikes older than this are forgotten
 HIGH_DEMAND_503: dict = {}   # model key -> [timestamps of recent 503 answers]
 
+# ─── 503 "high demand" round-robin (auto / pool requests) ────────────────────────────────────────────────────
+# Only the KEY that got the 503 is paused (for this model only, _hd503_secs() = dashboard "503 cooldown"); every other
+# key of that model stays usable. For a pool (auto) request that gets a 503 high demand:
+#   1. that (key, model) is paused, and THIS request moves on to the NEXT available model (priority order, wrapping around).
+#   2. when every available model answered 503 once = one failed ROUND. The next round starts again from the PRIORITY model
+#      (first model of the dashboard list) with its NEXT free key (the key that just failed is still paused).
+#   3. after HD_RR_ROUNDS failed rounds the request goes back to the priority model (as far as its keys are free / their
+#      cooldown is over), HD_RR_RESTARTS times at most; then the client gets a 503 "models_high_demand" (WebAI fallback first).
+#   New requests start at the priority model again as soon as its paused keys are free (routing mode "drain").
+# HD_RR=0 switches this off (old behaviour: only that key+model paused, the same model's next key is tried first).
+HD_RR_ENABLED = os.environ.get("HD_RR", "1") != "0"
+HD_RR_ROUNDS = max(1, int(os.environ.get("HD_RR_ROUNDS", "3")))        # failed round-robin rounds before "back to the priority model"
+HD_RR_RESTARTS = max(0, int(os.environ.get("HD_RR_RESTARTS", "1")))    # how many times a request may restart from the priority model
+HD_RR_PAUSE = max(0.0, float(os.environ.get("HD_RR_PAUSE", "2")))      # seconds to wait between two rounds (503s are usually brief)
+
 
 def _is_high_demand_503(status, text) -> bool:
     return status == 503 and any(w in (text or "").lower() for w in ("high demand", "unavailable", "overloaded"))
@@ -2091,9 +2106,12 @@
     _routing_persist()
 
 
-def _list_combos_in_order(requested_model: str):
+def _list_combos_in_order(requested_model: str, hd_priority: bool = False, hd_after=None):
     """
     Builds the ordered candidate list (key, model) for a request.
+    hd_priority / hd_after: used by the 503 "high demand" round-robin (pool requests only). The models are then listed in
+    PRIORITY order (dashboard order, "last" models at the end), starting AFTER the model `hd_after` (lower-case key) and
+    wrapping around; hd_after=None starts at the priority model (first one).
     Must be called while already holding state_lock.
 
     Two modes:
@@ -2149,7 +2167,7 @@
         # already failed in this request).
         _drain = _routing_is_drain()
         # drain mode keeps the dashboard order (sorted() is stable, constant key = no re-ordering)
-        _sort_key = (lambda m: 0) if _drain else _model_sort_key
+        _sort_key = (lambda m: 0) if (_drain or hd_priority) else _model_sort_key
         _lk = _last_keys()
         if _lk is None:
             # default: all "lite" models are one last tier
@@ -2163,6 +2181,18 @@
             last_set = {_bk(m["name"]) for m in last_models}
             first = sorted([m for m in active_models if _bk(m["name"]) not in last_set], key=_sort_key)
             tiers = [first] + [[m] for m in last_models]
+        if hd_priority:
+            # 503 high-demand round robin: ONE flat list in priority order, rotated to start after the model that just failed
+            flat = [m for tier in tiers for m in tier]
+            if hd_after:
+                _ix = next((i for i, m in enumerate(flat) if _bk(m["name"]) == hd_after), None)
+                if _ix is not None:
+                    flat = flat[_ix + 1:] + flat[:_ix + 1]
+            for m_i, m in enumerate(flat):
+                for i in range(K):
+                    k_i = (current_combo_idx + i) % K
+                    combos.append((k_i, m_i, API_KEYS[k_i], m))
+            return combos
         for tier in tiers:
             M = len(tier)
             if M == 0:
@@ -2202,7 +2232,8 @@
     return combos
 
 
-def acquire_next_slot(requested_model: str, exclude: set, est_tokens: int = 0):
+def acquire_next_slot(requested_model: str, exclude: set, est_tokens: int = 0,
+                      skip_models=None, hd_priority: bool = False, hd_after=None):
     """
     Atomically picks the next viable (key, model) combo AND reserves it
     (records the request timestamp) in one locked step.
@@ -2224,12 +2255,14 @@
         if not API_KEYS:
             return None
 
-        combos = _list_combos_in_order(requested_model)
+        combos = _list_combos_in_order(requested_model, hd_priority=hd_priority, hd_after=hd_after)
         _honor_block = _block_applies(requested_model)
 
         for (k_i, m_i, key, model) in combos:
             if (key, model["name"]) in exclude:
                 continue
+            if skip_models and _bk(model["name"]) in skip_models:
+                continue          # this model already answered 503 high demand in the current round of THIS request
             if _honor_block and _is_model_blocked(model["name"]):
                 continue
             if (key, model["name"]) in PERMANENTLY_BROKEN_MODELS:
@@ -6148,6 +6181,12 @@
     img_skip = set()         # (key, model) pairs skipped because of that (undone if we have to strip the images)
     images_stripped = False
     cap_fail_models = set()  # models that said "I do not support this" (non-image); after 3 the request itself is blamed
+    # ── 503 "high demand" round robin (auto / pool requests, see HD_RR_* above) ──
+    hd_round_failed = set()  # model keys that answered 503 high demand in the CURRENT round of this request (skipped until the round ends)
+    hd_last_model = None     # model key that failed last -> the next model after it (priority order, wrapping) gets the request
+    hd_rounds = 0            # failed rounds since the last (re)start from the priority model
+    hd_restarts_used = 0     # how often this request already went back to the priority model after HD_RR_ROUNDS failed rounds
+    hd_total = 0             # 503 high demand answers in this request (statistics / error text)
 
     def _skip_model_this_request(model_name):
         # this MODEL cannot take this input -> no key of it is tried again for this request
@@ -6197,8 +6236,17 @@
                         else:
                             _handle_429(key, actual_model, err, raw=resp.text, status=resp.status_code)
                 elif resp.status_code in (500, 502, 503, 504, 408):
-                    with state_lock:
-                        _apply_rpm_cooldown(key, actual_model, seconds=(_hd503_secs() if resp.status_code == 503 else 60))
+                    if HD_RR_ENABLED and (requested_model or "").lower() in _GENERIC_MODEL_ALIASES \
+                            and _is_high_demand_503(resp.status_code, getattr(resp, "text", "")):
+                        with state_lock:
+                            _apply_rpm_cooldown(key, actual_model, seconds=_hd503_secs())
+                        hd_round_failed.add(_bk(actual_model))
+                        hd_last_model = _bk(actual_model)
+                        hd_total += 1
+                        _trail(f"503 high demand on pinned {actual_model} (key …{key[-4:]}) -> this key paused {_hd503_label()}, next model")
+                    else:
+                        with state_lock:
+                            _apply_rpm_cooldown(key, actual_model, seconds=(_hd503_secs() if resp.status_code == 503 else 60))
                 if resp.status_code == 400:
                     _e400 = resp.text.lower()
                     if (has_images and image_fix.is_image_error(_e400)) or image_fix.is_capability_error(_e400):
@@ -6249,7 +6297,30 @@
             break
 
         # Atomic: pick a viable (key, model) AND reserve its RPM slot in one lock hold.
-        slot = acquire_next_slot(requested_model, exclude=tried, est_tokens=_est_tokens)
+        slot = acquire_next_slot(requested_model, exclude=tried, est_tokens=_est_tokens,
+                                 skip_models=hd_round_failed,
+                                 hd_priority=(hd_total > 0), hd_after=hd_last_model)
+
+        if slot is None and _is_pool_req and HD_RR_ENABLED and hd_round_failed:
+            # Every available model answered 503 high demand once = one FAILED ROUND.
+            hd_rounds += 1
+            _trail(f"round {hd_rounds}/{HD_RR_ROUNDS} failed: every available model said 503 high demand")
+            if hd_rounds >= HD_RR_ROUNDS:
+                if hd_restarts_used >= HD_RR_RESTARTS:
+                    exit_reason = "hd_exhausted"
+                    attempt_errors.append(f"{HD_RR_ROUNDS} round-robin rounds failed"
+                                          + (f" (and {hd_restarts_used} restart(s) from the priority model)" if hd_restarts_used else "")
+                                          + f": every model answered 503 high demand ({hd_total} answers)")
+                    _trail("503 high demand: rounds used up -> error to the client")
+                    break
+                hd_restarts_used += 1
+                hd_rounds = 0
+                _trail(f"{HD_RR_ROUNDS} rounds failed -> back to the PRIORITY model from the beginning, with its free keys "
+                       f"(restart {hd_restarts_used}/{HD_RR_RESTARTS})")
+            hd_round_failed.clear()
+            hd_last_model = None                            # next round starts at the priority model, on its next free key
+            _cancel_sleep(HD_RR_PAUSE)
+            continue
 
         if slot is None:
             # Nothing usable right now. Is anything merely waiting (RPM window / cooldown) or is all of it dead for today?
@@ -6477,6 +6548,18 @@
                 _hd_text = ""
                 try: _hd_text = resp.text
                 except: pass
+                if HD_RR_ENABLED and _is_pool_req and _is_high_demand_503(resp.status_code, _hd_text):
+                    # 503 HIGH DEMAND: ONLY this key is paused for this model (_hd503_secs()); its other keys stay usable.
+                    # THIS request goes on to the NEXT model; in the next round this model is tried again with its next free key.
+                    with state_lock:
+                        _apply_rpm_cooldown(key, actual_model, seconds=_hd503_secs())
+                    tried.discard((key, actual_model))      # allowed again in a later round (the cooldown still protects it)
+                    hd_round_failed.add(_bk(actual_model))
+                    hd_last_model = _bk(actual_model)
+                    hd_total += 1
+                    attempt_errors.append(f"503 {actual_model} (…{key[-4:]}): high demand -> this key paused {_hd503_label()}, next model")
+                    _trail(f"503 high demand on {actual_model} (key …{key[-4:]}) -> this key paused {_hd503_label()}, next model")
+                    continue
                 _hd_hit = False
                 _is_hd = _is_high_demand_503(resp.status_code, _hd_text)
                 with state_lock:
@@ -6680,6 +6763,19 @@
         out_headers = [(n, v) for n, v in last_resp.raw.headers.items() if n.lower() not in excluded]
         return Response(last_resp.content, last_resp.status_code, out_headers)
 
+    if hd_total > 0 and exit_reason in ("once_done", "all_cooling", "soonest_too_far"):
+        exit_reason = "hd_exhausted"         # the keys are only paused because Google said 503 high demand
+    if exit_reason == "hd_exhausted":
+        msg = (f"Google says 'high demand' (503) for every available model and free key ({hd_total} attempts, "
+               f"{hd_rounds + hd_restarts_used * HD_RR_ROUNDS} full round(s)"
+               + (f", {hd_restarts_used} restart(s) from the priority model" if hd_restarts_used else "")
+               + "). This is Google's capacity, not your quota. Please retry in a moment.")
+        if hasattr(g, "log_entry"):
+            g.log_entry["error_detail"] = f"models_high_demand: {msg} || " + " || ".join(attempt_errors[-3:])
+        return Response(json.dumps({"error": {"message": msg, "type": "server_error", "code": "models_high_demand",
+                                              "retry_after_seconds": 20,
+                                              "details": attempt_errors[-6:] + [fb_info]}}),
+                        503, {"Content-Type": "application/json", "Retry-After": "20"})
     if exit_reason in ("once_done", "all_cooling", "soonest_too_far"):
         _sn = int(soonest) + 1
         _tpm_msg = (" Cause: Google's TOKENS-per-minute (TPM) limit of the models (not the request limit)." if tpm_any else "")
