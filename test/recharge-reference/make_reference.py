"""Run the training notebook's own fill and WTF functions on a CSV and save the
per-year recharge as the reference the JS port (src/recharge.js) is tested against.

    python -I test/recharge-reference/make_reference.py <notebook.ipynb> <input.csv> <out.json> [overrides.json]
"""
import json, sys
nb_path, csv_path, out_json = sys.argv[1:4]
overrides = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else {}
nb = json.load(open(nb_path))
src = next("".join(c["source"]) for c in nb["cells"]
           if c["cell_type"] == "code" and "def water_table_fluctuation" in "".join(c["source"]))
ns = {}
exec(compile(src, "notebook_functions", "exec"), ns)
df = ns["load_grace_csv"](csv_path, "GWSa")
result, model, _ = ns["fill_gaps"](df, "auto")
start = ns["auto_water_year_start"](result)
wtf = ns["water_table_fluctuation"](result, start, {int(k): v for k, v in overrides.items()})
rows = []
for year, r in wtf.iterrows():
    rows.append({"water_year": int(year), "trough": r.trough_date.strftime("%Y-%m"), "peak": r.peak_date.strftime("%Y-%m"),
                 "fit_start": r.fit_start.strftime("%Y-%m"), "S_P": r.S_P, "S_B": r.S_B, "S_L": r.S_L,
                 "R_S": r.R_S, "R_D": r.R_D, "R1": r.R1, "R2": r.R2,
                 "long_extrapolation": bool(r.long_extrapolation), "filled_parts": r.filled_parts})
json.dump({"start_month": start, "overrides": overrides, "rows": rows}, open(out_json, "w"), indent=1)
print("start month", start, "years", len(rows), "mean R1 %.3f R2 %.3f" % (wtf.R1.mean(), wtf.R2.mean()))
