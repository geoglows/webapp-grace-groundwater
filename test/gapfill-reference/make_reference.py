"""Run the training notebook's own gap-fill functions on a CSV and save the result
as the reference the JS port is tested against."""
import json, sys
import numpy as np
nb_path, csv_path, out_csv, out_json = sys.argv[1:5]
nb = json.load(open(nb_path))
src = next("".join(c["source"]) for c in nb["cells"]
           if c["cell_type"] == "code" and "def fill_gaps" in "".join(c["source"]))
ns = {}
exec(compile(src, "notebook_functions", "exec"), ns)
df = ns["load_grace_csv"](csv_path, "GWSa")
result, model, table = ns["fill_gaps"](df, "auto")
start = df.index[0]
bps = [(start + ns["pd"].DateOffset(months=int(b))).strftime("%Y-%m") for b in model["breakpoints"]]
out = result[["observed", "trend", "seasonal", "filled", "is_filled"]].copy()
out["is_filled"] = out["is_filled"].astype(int)
out.index = out.index.strftime("%Y-%m")
out.to_csv(out_csv, float_format="%.6f", index_label="month")
json.dump({"variable": "GWSa", "breakpoints": bps, "breakpoint_months": [int(b) for b in model["breakpoints"]],
           "bic": {str(k): float(v) for k, v in table["BIC"].items()},
           "n_observed": int(model["n"]), "n_filled": int(out["is_filled"].sum())}, open(out_json, "w"), indent=2)
print(table); print("breakpoints", bps)
