"""Builds docs/data/replications.json, the replication attempts Research Finder shows on results, from the FORRT
Replication Database (FReD), which FORRT publishes under CC BY 4.0 and rebuilds every week.

    python3 tools/replications.py                  # downloads FReD's current FLoRA data
    python3 tools/replications.py flora-data.json  # or reads a copy

The file keeps only what a result needs: for each original study (by DOI, in lower case), its replications and
reproductions as [link, year, outcome code, title, outcome in FReD's words when the code is "r" or "o"].
"""
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

SOURCE = "https://raw.githubusercontent.com/forrtproject/fred-apps/main/data/flora-data.json"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "replications.json"
CODES = {"successful": "s", "failed": "f", "mixed": "m"}


def load(arg):
    if arg:
        return json.loads(Path(arg).read_text(encoding="utf-8"))
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "research-finder-data/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    data = load(sys.argv[1] if len(sys.argv) > 1 else "")
    studies, attempts = {}, 0
    for e in data["entries"]:
        doi = (e.get("doi_original") or "").strip().lower()
        if not doi:
            continue
        rows = []
        for r in e.get("replications", []):
            link = (r.get("doi_replication") or "").strip() or (r.get("url_replication") or "").strip()
            if not link:
                continue
            outcome = (r.get("outcome") or "").strip()
            code = "r" if r.get("study_type") == "reproduction" else CODES.get(outcome, "o")
            title = " ".join((r.get("title_replication") or "").split())
            if len(title) > 110:
                title = title[:107].rstrip() + "…"
            row = [link, r.get("year_replication") or 0, code, title]
            if code in ("r", "o") and outcome:
                row.append(outcome)
            rows.append(row)
        if rows:
            rows.sort(key=lambda x: (x[1] or 9999, x[0]))
            studies[doi] = rows
            attempts += len(rows)
    generated = (data.get("metadata") or {}).get("generated", "")[:10] or date.today().isoformat()
    out = {
        "about": "Replications and reproductions of studies, from the FORRT Replication Database (FReD)",
        "license": "CC BY 4.0, FORRT Replication Database (https://forrt.org/replication-hub/)",
        "source": SOURCE,
        "generated": generated,
        "originals": len(studies),
        "attempts": attempts,
        "studies": dict(sorted(studies.items())),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {len(studies)} studies, {attempts} attempts, data of {generated}, {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
