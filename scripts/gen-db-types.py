#!/usr/bin/env python3
"""Génère js/database.types.ts (types de la base) à partir de supabase/schema.sql.

    python3 scripts/gen-db-types.py            écrit js/database.types.ts
    python3 scripts/gen-db-types.py --check    vérifie que le fichier est à jour (code de sortie 1 sinon)

Le schéma est rejouable : on l'analyse instruction par instruction (create table, alter table add column,
create function) pour retrouver l'état final. Nécessite : pip install pglast
"""
import sys
from pathlib import Path
from pglast import parse_sql

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "supabase" / "schema.sql"
OUT = ROOT / "js" / "database.types.ts"

SCALARS = {
    "uuid": "string", "text": "string", "varchar": "string", "bpchar": "string", "citext": "string",
    "timestamptz": "string", "timestamp": "string", "date": "string", "time": "string", "bytea": "string",
    "bool": "boolean", "boolean": "boolean",
    "int2": "number", "int4": "number", "int8": "number", "float4": "number", "float8": "number", "numeric": "number",
    "jsonb": "Json", "json": "Json",
}


def type_name(tn):
    """Nom TypeScript d'un type SQL (TypeName de pglast)."""
    names = [n.sval for n in tn.names if n.sval != "pg_catalog"]
    base = names[-1] if names else "unknown"
    ts = SCALARS.get(base)
    if ts is None:
        ts = f"__row:{base}" if names and names[0] == "public" and len(names) == 2 else "unknown"
    if tn.arrayBounds:
        ts = f"{ts}[]"
    return ts


class Column:
    def __init__(self, name, ts, not_null=False, has_default=False, union=None, pk=False):
        self.name, self.ts, self.not_null, self.has_default, self.union, self.pk = name, ts, not_null, has_default, union, pk


tables = {}      # nom -> {"cols": {nom: Column}, "fks": [...]}
functions = {}   # nom -> dict


def in_list(expr):
    """Valeurs d'un « col in ('a','b') » ou d'un « col <@ array['a','b'] » -> (colonne, [valeurs]) ; sinon None."""
    if type(expr).__name__ == "A_Expr" and expr.kind.name == "AEXPR_OP" and expr.name[-1].sval == "<@":
        if type(expr.lexpr).__name__ != "ColumnRef" or type(expr.rexpr).__name__ != "A_ArrayExpr":
            return None
        values = [i.val.sval for i in expr.rexpr.elements if type(i).__name__ == "A_Const" and hasattr(i.val, "sval")]
        return expr.lexpr.fields[-1].sval, values
    if type(expr).__name__ != "A_Expr" or expr.kind.name != "AEXPR_IN":
        return None
    if type(expr.lexpr).__name__ != "ColumnRef":
        return None
    values = []
    for item in expr.rexpr:
        if type(item).__name__ != "A_Const" or not hasattr(item.val, "sval"):
            return None
        values.append(item.val.sval)
    return expr.lexpr.fields[-1].sval, values


def add_fk(table, cols, constraint):
    target = constraint.pktable
    if target is None or target.schemaname not in (None, "public"):
        return
    if target.schemaname is None and target.relname in ("users",):
        return
    ref_cols = [c.sval for c in constraint.pk_attrs] if constraint.pk_attrs else ["id"]
    tables[table]["fks"].append({"cols": cols, "ref": target.relname, "ref_cols": ref_cols})


def column_from_def(table, element):
    col = Column(element.colname, type_name(element.typeName))
    for con in element.constraints or []:
        kind = con.contype.name
        if kind == "CONSTR_NOTNULL":
            col.not_null = True
        elif kind == "CONSTR_PRIMARY":
            col.not_null = True
            col.pk = True
        elif kind == "CONSTR_DEFAULT":
            col.has_default = True
        elif kind == "CONSTR_CHECK":
            found = in_list(con.raw_expr)
            if found and found[0] == col.name:
                col.union = found[1]
        elif kind == "CONSTR_FOREIGN":
            add_fk(table, [col.name], con)
    return col


for raw in parse_sql(SCHEMA.read_text(encoding="utf-8")):
    stmt = raw.stmt
    kind = type(stmt).__name__
    if kind == "CreateStmt" and stmt.relation.schemaname == "public":
        name = stmt.relation.relname
        tables[name] = {"cols": {}, "fks": []}
        pk_cols = []
        for el in stmt.tableElts:
            if type(el).__name__ == "ColumnDef":
                tables[name]["cols"][el.colname] = column_from_def(name, el)
            elif type(el).__name__ == "Constraint":
                if el.contype.name == "CONSTR_PRIMARY":
                    pk_cols = [k.sval for k in el.keys]
                elif el.contype.name == "CONSTR_FOREIGN":
                    add_fk(name, [k.sval for k in el.fk_attrs], el)
                elif el.contype.name == "CONSTR_CHECK":
                    found = in_list(el.raw_expr)
                    if found and found[0] in tables[name]["cols"]:
                        tables[name]["cols"][found[0]].union = found[1]
        for c in pk_cols:
            tables[name]["cols"][c].not_null = True
    elif kind == "AlterTableStmt" and stmt.relation.schemaname == "public" and stmt.relation.relname in tables:
        name = stmt.relation.relname
        for cmd in stmt.cmds:
            sub = cmd.subtype.name
            if sub == "AT_AddColumn":
                el = cmd.def_
                tables[name]["cols"].setdefault(el.colname, column_from_def(name, el))
            elif sub == "AT_DropNotNull":
                tables[name]["cols"][cmd.name].not_null = False
            elif sub == "AT_AddConstraint" and cmd.def_.contype.name == "CONSTR_CHECK":
                found = in_list(cmd.def_.raw_expr)
                if found and found[0] in tables[name]["cols"]:
                    tables[name]["cols"][found[0]].union = found[1]
            elif sub == "AT_AddConstraint" and cmd.def_.contype.name == "CONSTR_FOREIGN":
                add_fk(name, [k.sval for k in cmd.def_.fk_attrs], cmd.def_)
            elif sub == "AT_DropConstraint":
                for cname, col in tables[name]["cols"].items():
                    if cmd.name == f"{name}_{cname}_check":
                        col.union = None
    elif kind == "CreateFunctionStmt" and (len(stmt.funcname) == 1 or stmt.funcname[0].sval == "public"):
        fname = stmt.funcname[-1].sval
        rt = stmt.returnType
        if rt is not None and [n.sval for n in rt.names][-1] == "trigger":
            functions.pop(fname, None)
            continue
        args, cols = [], []
        for p in stmt.parameters or []:
            mode = p.mode.name
            if mode in ("FUNC_PARAM_TABLE", "FUNC_PARAM_OUT"):
                cols.append((p.name, type_name(p.argType)))
            else:
                args.append((p.name, type_name(p.argType), p.defexpr is not None))
        functions[fname] = {"args": args, "cols": cols, "ret": type_name(rt) if rt is not None else "void", "setof": bool(rt.setof) if rt is not None else False,
                            "ret_name": [n.sval for n in rt.names][-1] if rt is not None else "void"}


# Types précis pour des colonnes jsonb (table, colonne) -> type TypeScript.
OVERRIDES = {
    ("messages", "attachments"): "Attachment[]",
}


def ts_of(col, table=None):
    if (table, col.name) in OVERRIDES:
        return OVERRIDES[(table, col.name)]
    if col.union and col.ts == "string":
        return " | ".join(f'"{v}"' for v in col.union)
    if col.union and col.ts == "string[]":
        return "(" + " | ".join(f'"{v}"' for v in col.union) + ")[]"
    return col.ts


def resolve(ts):
    """Remplace « __row:table » par le type Row de la table."""
    if ts.startswith("__row:"):
        base = ts[6:]
        arr = base.endswith("[]")
        base = base[:-2] if arr else base
        out = f'Database["public"]["Tables"]["{base}"]["Row"]' if base in tables else "unknown"
        return out + ("[]" if arr else "")
    return ts


def paren(ts):
    return f"({ts})" if "|" in ts else ts


lines = []
w = lines.append
w("// Types de la base, GÉNÉRÉS à partir de supabase/schema.sql — ne pas modifier à la main.")
w("// Pour les mettre à jour : python3 scripts/gen-db-types.py (puis commit). Nécessite : pip install pglast")
w("")
w('import type { Attachment } from "./types.js";')
w("")
w("export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];")
w("")
w("export interface Database {")
w("  public: {")
w("    Tables: {")
for tname in sorted(tables):
    t = tables[tname]
    cols = t["cols"]
    w(f"      {tname}: {{")
    w("        Row: {")
    for cname, c in cols.items():
        w(f"          {cname}: {paren(ts_of(c, tname))}{'' if c.not_null else ' | null'};")
    w("        };")
    for label, optional in (("Insert", lambda c: c.has_default or not c.not_null), ("Update", lambda c: True)):
        w(f"        {label}: {{")
        for cname, c in cols.items():
            w(f"          {cname}{'?' if optional(c) else ''}: {paren(ts_of(c, tname))}{' | null' if not c.not_null else ''};")
        w("        };")
    w("        Relationships: [")
    for fk in t["fks"]:
        fname = f"{tname}_{'_'.join(fk['cols'])}_fkey"
        w("          {")
        w(f'            foreignKeyName: "{fname}";')
        w(f"            columns: [{', '.join(chr(34) + c + chr(34) for c in fk['cols'])}];")
        w("            isOneToOne: false;")
        w(f'            referencedRelation: "{fk["ref"]}";')
        w(f"            referencedColumns: [{', '.join(chr(34) + c + chr(34) for c in fk['ref_cols'])}];")
        w("          },")
    w("        ];")
    w("      };")
w("    };")
w("    Views: { [_ in never]: never };")
w("    Functions: {")
for fname in sorted(functions):
    f = functions[fname]
    if f["args"]:
        args = "{ " + "; ".join(f"{n}{'?' if d else ''}: {paren(resolve(t))}" for n, t, d in f["args"]) + " }"
    else:
        args = "Record<PropertyKey, never>"
    if f["cols"]:
        row = "{ " + "; ".join(f"{n}: {paren(resolve(t))}" for n, t in f["cols"]) + " }"
        ret = row + "[]"
    elif f["ret_name"] == "void":
        ret = "undefined"
    elif f["ret_name"] == "record":
        ret = "unknown"
    else:
        ret = resolve(f["ret"])
        if f["setof"]:
            ret = f"{paren(ret)}[]"
    w(f"      {fname}: {{ Args: {args}; Returns: {ret} }};")
w("    };")
w("    Enums: { [_ in never]: never };")
w("    CompositeTypes: { [_ in never]: never };")
w("  };")
w("}")
w("")
content = "\n".join(lines)

if "--check" in sys.argv:
    if not OUT.exists() or OUT.read_text(encoding="utf-8") != content:
        print("js/database.types.ts n'est pas à jour : lance python3 scripts/gen-db-types.py")
        sys.exit(1)
    print("Types de la base à jour")
else:
    OUT.write_text(content, encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)} : {len(tables)} tables, {len(functions)} fonctions")
