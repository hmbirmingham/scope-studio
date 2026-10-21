"""The physics plug-in's Python side.

The engine copies this file and one job file into a private directory and
runs `python3 -I -B harness.py job.json` inside the OS sandbox (no network,
nothing writable but that directory, resource limits). It never runs on the
host. The job says what to do; the answer is printed as one line that starts
with a marker carrying the job's nonce, so anything else the computation
prints cannot be mistaken for it.

Modes:
  probe     report whether NumPy, SciPy and Pint import, and their versions.
  check     dimensional consistency ("units") and limiting cases ("limits")
            of a closed-form result. The expression is parsed with `ast` and
            evaluated by a whitelist evaluator: arithmetic, a fixed set of
            functions and the declared variables, nothing else.
  compute   run a computation (model-written code, or the closed-form
            expression of a derivation) on Pint quantities and return each
            declared output in its declared units.
"""

import ast
import contextlib
import io
import json
import math
import operator
import sys

MARK = "@@physics-result@@"
MAX_EXPRESSION = 2000
MAX_LOG = 4000


class PhysicsInputError(Exception):
    """A problem with what the job asked for, reported as such."""


def finish(nonce, payload):
    sys.stdout.write("\n" + MARK + nonce + " " + json.dumps(payload, allow_nan=False, default=str) + "\n")
    sys.stdout.flush()


def probe(_job):
    missing = []
    versions = {"python": sys.version.split()[0]}
    for name in ("numpy", "scipy", "pint"):
        try:
            module = __import__(name)
            versions[name] = getattr(module, "__version__", "unknown")
        except Exception:  # an import can fail with more than ImportError
            missing.append(name)
    return {"ok": not missing, "missing": missing, "versions": versions}


# The registry is made once per process: building it is the slow part of
# importing Pint.
_UREG = None


def ureg():
    global _UREG
    if _UREG is None:
        import pint

        _UREG = pint.UnitRegistry()
    return _UREG


def quantity(value):
    """A Pint quantity from "9.81 m/s^2", a number, or {value, units}.

    Pint's own parser reads the string; it is not Python's eval.
    """
    reg = ureg()
    if isinstance(value, bool):
        raise PhysicsInputError("a quantity cannot be a boolean")
    if isinstance(value, (int, float)):
        return reg.Quantity(float(value))
    if isinstance(value, dict):
        magnitude = value.get("value")
        units = value.get("units", "")
        if isinstance(magnitude, bool) or not isinstance(magnitude, (int, float)):
            raise PhysicsInputError("a quantity's value must be a number")
        if not isinstance(units, str):
            raise PhysicsInputError("a quantity's units must be a string")
        return reg.Quantity(float(magnitude), units or "dimensionless")
    if isinstance(value, str):
        parsed = reg.Quantity(value)
        if not isinstance(parsed.magnitude, (int, float)):
            raise PhysicsInputError("a quantity must be a single number with units")
        return reg.Quantity(float(parsed.magnitude), parsed.units)
    raise PhysicsInputError("a quantity must be a string such as '9.81 m/s^2', a number or {value, units}")


def unit(units):
    if not isinstance(units, str) or not units.strip():
        raise PhysicsInputError("units must be a non-empty string")
    return ureg().Quantity(1.0, units)


def dimensionless(x):
    """The plain number behind a dimensionless quantity (radians included).

    A quantity with dimensions raises DimensionalityError, which is exactly
    the check: sin(1 m) is a units error.
    """
    reg = ureg()
    if isinstance(x, reg.Quantity):
        return float(x.to("dimensionless").magnitude)
    return float(x)


def wrap(fn):
    return lambda *args: ureg().Quantity(fn(*[dimensionless(a) for a in args]))


def special(name):
    def call(*args):
        import scipy.special

        return getattr(scipy.special, name)(*args)

    return call


def atan2(y, x):
    reg = ureg()
    y = y if isinstance(y, reg.Quantity) else reg.Quantity(float(y))
    x = x if isinstance(x, reg.Quantity) else reg.Quantity(float(x))
    return reg.Quantity(math.atan2(y.magnitude, x.to(y.units).magnitude), "radian")


def hypot(a, b):
    reg = ureg()
    a = a if isinstance(a, reg.Quantity) else reg.Quantity(float(a))
    b = b if isinstance(b, reg.Quantity) else reg.Quantity(float(b))
    return reg.Quantity(math.hypot(a.magnitude, b.to(a.units).magnitude), a.units)


FUNCTIONS = {
    "sqrt": lambda x: x ** 0.5,
    "abs": abs,
    "sin": wrap(math.sin),
    "cos": wrap(math.cos),
    "tan": wrap(math.tan),
    "asin": wrap(math.asin),
    "acos": wrap(math.acos),
    "atan": wrap(math.atan),
    "arcsin": wrap(math.asin),
    "arccos": wrap(math.acos),
    "arctan": wrap(math.atan),
    "sinh": wrap(math.sinh),
    "cosh": wrap(math.cosh),
    "tanh": wrap(math.tanh),
    "exp": wrap(math.exp),
    "log": wrap(math.log),
    "ln": wrap(math.log),
    "log10": wrap(math.log10),
    "erf": wrap(math.erf),
    # Complete elliptic integrals, parameter m = k^2 (SciPy's convention).
    "ellipk": wrap(lambda m: float(special("ellipk")(m))),
    "ellipe": wrap(lambda m: float(special("ellipe")(m))),
    "atan2": atan2,
    "hypot": hypot,
}

CONSTANTS = {"pi": math.pi, "e": math.e}

BINARY = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: None,  # handled separately: the exponent must be dimensionless
}
UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def evaluate(expression, values):
    """Evaluates a closed-form expression over Pint quantities.

    Only numbers, the declared variables, pi and e, + - * / ** and the
    functions above are accepted; anything else (attributes, subscripts,
    comprehensions, keyword arguments, strings) is refused before evaluation.
    """
    if not isinstance(expression, str) or not expression.strip():
        raise PhysicsInputError("the expression is empty")
    if len(expression) > MAX_EXPRESSION:
        raise PhysicsInputError("the expression is too long")
    # Engineers write powers as ^; Python's ^ is xor, which no physics means.
    tree = ast.parse(expression.replace("^", "**"), mode="eval")
    reg = ureg()

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise PhysicsInputError("only numbers may appear as constants")
            # Floats, never Python's unbounded ints: 10**10**10 overflows
            # instead of computing forever.
            return reg.Quantity(float(node.value))
        if isinstance(node, ast.Name):
            if node.id in values:
                return values[node.id]
            if node.id in CONSTANTS:
                return reg.Quantity(CONSTANTS[node.id])
            raise PhysicsInputError("unknown name '%s': declare it as a variable" % node.id)
        if isinstance(node, ast.BinOp) and type(node.op) in BINARY:
            left = ev(node.left)
            right = ev(node.right)
            if isinstance(node.op, ast.Pow):
                return left ** dimensionless(right)
            return BINARY[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in UNARY:
            return UNARY[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
                raise PhysicsInputError("only these functions are allowed: " + ", ".join(sorted(FUNCTIONS)))
            if node.keywords:
                raise PhysicsInputError("functions take positional arguments only")
            return FUNCTIONS[node.func.id](*[ev(arg) for arg in node.args])
        raise PhysicsInputError("'%s' is not allowed in an expression" % type(node).__name__)

    result = ev(tree)
    if not isinstance(result, reg.Quantity):
        result = reg.Quantity(float(result))
    return result


def finite(x):
    return isinstance(x, float) and math.isfinite(x)


def describe(q, units=None):
    q = q.to(units) if units else q
    return {"value": float(q.magnitude), "units": str(q.units)}


def error_text(err):
    return ("%s: %s" % (type(err).__name__, err))[:500]


def check_units(spec):
    variables = {name: quantity(value) for name, value in spec["variables"].items()}
    target = unit(spec["units"])
    try:
        value = evaluate(spec["expression"], variables)
    except PhysicsInputError:
        raise
    except Exception as err:
        return {"ok": False, "detail": "the expression is not dimensionally consistent: " + error_text(err)}
    if value.dimensionality != target.dimensionality:
        return {
            "ok": False,
            "detail": "the expression has dimensions %s but the result is declared in %s (%s)"
            % (value.dimensionality, spec["units"], target.dimensionality),
            "value": describe(value),
        }
    converted = value.to(spec["units"])
    if not finite(float(converted.magnitude)):
        return {"ok": False, "detail": "the expression is not finite at the given values"}
    return {
        "ok": True,
        "detail": "dimensionally consistent: %s evaluates to %.6g %s" % (spec.get("symbol", "the result"), converted.magnitude, spec["units"]),
        "value": describe(converted),
    }


def check_limits(spec):
    limits = spec.get("limits") or []
    if not limits:
        return {"ok": False, "detail": "the derivation declares no limiting case to check"}
    base = {name: quantity(value) for name, value in spec["variables"].items()}
    target = spec["units"]
    cases = []
    for case in limits:
        name = case.get("name", "limit")
        values = dict(base)
        for var, value in (case.get("set") or {}).items():
            if var not in values:
                cases.append({"name": name, "ok": False, "detail": "sets '%s', which is not a declared variable" % var})
                break
            values[var] = quantity(value)
        else:
            try:
                got = evaluate(spec["expression"], values).to(target).magnitude
                if case.get("expect") is not None:
                    want = evaluate(case["expect"], values).to(target).magnitude
                else:
                    want = quantity(case["expectValue"]).to(target).magnitude
            except PhysicsInputError:
                raise
            except Exception as err:
                cases.append({"name": name, "ok": False, "detail": error_text(err)})
                continue
            got = float(got)
            want = float(want)
            rtol = float(case.get("rtol", 1e-3))
            atol = float(case.get("atol", 0.0))
            diff = abs(got - want)
            ok = finite(got) and finite(want) and (diff <= atol or diff <= rtol * abs(want))
            cases.append({
                "name": name,
                "ok": ok,
                "got": got,
                "expected": want,
                "units": target,
                "detail": "%s: %.9g vs expected %.9g %s (rtol %g%s)"
                % (name, got, want, target, rtol, ", atol %g" % atol if atol else ""),
            })
    passed = sum(1 for case in cases if case["ok"])
    failed = [case for case in cases if not case["ok"]]
    detail = "%d of %d limiting cases hold" % (passed, len(cases))
    if failed:
        detail += "; failing: " + "; ".join(case["detail"] for case in failed)
    return {"ok": not failed, "detail": detail, "cases": cases}


CHECKS = {"units": check_units, "limits": check_limits}


def check(job):
    spec = job["spec"]
    results = {}
    for name in job["checks"]:
        try:
            results[name] = CHECKS[name](spec)
        except PhysicsInputError as err:
            results[name] = {"ok": False, "detail": str(err)}
        except Exception as err:
            results[name] = {"ok": False, "detail": error_text(err)}
    return {"ok": True, "checks": results}


RESERVED = {"ureg", "Q_", "np", "numpy", "scipy", "math", "inputs", "result"}


def compute(job):
    import numpy
    import scipy
    import scipy.integrate  # noqa: F401  the submodules most computations use
    import scipy.optimize  # noqa: F401
    import scipy.special  # noqa: F401

    reg = ureg()
    inputs = {}
    for name, value in job["inputs"].items():
        if name in RESERVED:
            raise PhysicsInputError("'%s' is reserved and cannot name an input" % name)
        inputs[name] = quantity(value)

    log = io.StringIO()
    if job.get("expression") is not None:
        result = {job["expressionOutput"]: evaluate(job["expression"], inputs)}
    else:
        namespace = {"ureg": reg, "Q_": reg.Quantity, "np": numpy, "numpy": numpy, "scipy": scipy, "math": math, "inputs": dict(inputs)}
        namespace.update(inputs)
        try:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                exec(compile(job["code"], "<computation>", "exec"), namespace)
        except Exception as err:
            return {"ok": False, "error": "computation_failed", "detail": error_text(err), "log": log.getvalue()[-MAX_LOG:]}
        result = namespace.get("result")
        if not isinstance(result, dict):
            return {"ok": False, "error": "no_result", "detail": "the computation must set result = {name: quantity, ...}", "log": log.getvalue()[-MAX_LOG:]}

    outputs = {}
    units = {}
    for name, declared in job["outputs"].items():
        if name not in result:
            units[name] = {"ok": False, "detail": "the computation did not produce '%s'" % name}
            continue
        value = result[name]
        if not isinstance(value, reg.Quantity):
            if isinstance(value, bool) or not isinstance(value, (int, float, numpy.floating, numpy.integer)):
                units[name] = {"ok": False, "detail": "'%s' is not a number or a quantity" % name}
                continue
            value = reg.Quantity(float(value))
        magnitude = value.magnitude
        if numpy.ndim(magnitude) != 0:
            units[name] = {"ok": False, "detail": "'%s' must be a single value, not an array" % name}
            continue
        try:
            converted = value.to(declared)
        except Exception as err:
            units[name] = {"ok": False, "detail": "'%s' is in %s, which cannot be expressed in %s: %s" % (name, value.units, declared, error_text(err))}
            continue
        number = float(converted.magnitude)
        if not finite(number):
            units[name] = {"ok": False, "detail": "'%s' is not finite" % name}
            continue
        outputs[name] = {"value": number, "units": declared}
        units[name] = {"ok": True, "detail": "'%s' = %.9g %s" % (name, number, declared)}
    return {"ok": True, "outputs": outputs, "units": units, "log": log.getvalue()[-MAX_LOG:]}


MODES = {"probe": probe, "check": check, "compute": compute}


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        job = json.load(handle)
    nonce = str(job.get("nonce", ""))
    try:
        payload = MODES[job["mode"]](job)
    except PhysicsInputError as err:
        payload = {"ok": False, "error": "invalid_input", "detail": str(err)}
    except Exception as err:
        payload = {"ok": False, "error": "harness_error", "detail": error_text(err)}
    try:
        finish(nonce, payload)
    except ValueError:
        # A NaN or infinity slipped into the payload; say so rather than
        # print JSON the engine cannot read.
        finish(nonce, {"ok": False, "error": "harness_error", "detail": "the result is not finite"})


if __name__ == "__main__":
    main()
