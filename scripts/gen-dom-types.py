#!/usr/bin/env python3
"""Génère js/dom-ids.d.ts : le type de chaque élément de index.html qui a un id (« #todo-items » -> HTMLUListElement…).

    python3 scripts/gen-dom-types.py           écrit js/dom-ids.d.ts
    python3 scripts/gen-dom-types.py --check   vérifie que le fichier est à jour

Ainsi $("#postit-input") est connu comme un <textarea> par la vérification des types.
"""
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
OUT = ROOT / "js" / "dom-ids.d.ts"

TYPES = {
    "input": "HTMLInputElement", "textarea": "HTMLTextAreaElement", "select": "HTMLSelectElement",
    "button": "HTMLButtonElement", "dialog": "HTMLDialogElement", "form": "HTMLFormElement",
    "img": "HTMLImageElement", "canvas": "HTMLCanvasElement", "a": "HTMLAnchorElement",
    "details": "HTMLDetailsElement", "label": "HTMLLabelElement", "ul": "HTMLUListElement",
    "ol": "HTMLOListElement", "li": "HTMLLIElement", "p": "HTMLParagraphElement",
    "h1": "HTMLHeadingElement", "h2": "HTMLHeadingElement", "h3": "HTMLHeadingElement", "h4": "HTMLHeadingElement",
    "span": "HTMLSpanElement", "div": "HTMLDivElement", "section": "HTMLElement", "header": "HTMLElement",
    "main": "HTMLElement", "aside": "HTMLElement", "nav": "HTMLElement", "small": "HTMLElement", "strong": "HTMLElement",
    "time": "HTMLTimeElement", "summary": "HTMLElement", "svg": "SVGSVGElement", "script": "HTMLScriptElement",
}


class Collector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = {}

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "id" and value:
                self.found.setdefault(value, TYPES.get(tag, "HTMLElement"))

    handle_startendtag = handle_starttag


parser = Collector()
parser.feed(HTML.read_text(encoding="utf-8"))
lines = [
    "// Types des éléments de index.html, GÉNÉRÉS — ne pas modifier à la main.",
    "// Mise à jour : python3 scripts/gen-dom-types.py (le workflow refuse de publier si ce fichier n'est pas à jour).",
    "",
    "export interface IdElements {",
]
for ident in sorted(parser.found):
    lines.append(f'  "#{ident}": {parser.found[ident]};')
lines += ["}", ""]
content = "\n".join(lines)

if "--check" in sys.argv:
    if not OUT.exists() or OUT.read_text(encoding="utf-8") != content:
        print("js/dom-ids.d.ts n'est pas à jour : lance python3 scripts/gen-dom-types.py")
        sys.exit(1)
    print("Types des éléments à jour")
else:
    OUT.write_text(content, encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)} : {len(parser.found)} éléments")
