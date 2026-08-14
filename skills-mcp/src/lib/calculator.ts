// Deterministic arithmetic expression evaluator - no eval(), no Function()
// constructor, no external library. Exists specifically because the main
// Chat agent was observed getting multi-step arithmetic wrong repeatedly on
// a real, consequential question (a body-fat/target-weight calculation) -
// this tool exists so it never has to do that math itself again.
// Supports + - * / ^ (right-assoc), unary +/-, parentheses, decimals, and a
// postfix % (divides by 100, so '18%' == 0.18).

type Token = { type: "num"; value: number } | { type: "op"; value: string };

const OPERATORS = new Set(["+", "-", "*", "/", "^", "(", ")", "%"]);

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const numStr = expr.slice(i, j);
      const value = Number(numStr);
      if (!Number.isFinite(value)) throw new Error(`Invalid number: '${numStr}'`);
      tokens.push({ type: "num", value });
      i = j;
      continue;
    }
    if (OPERATORS.has(c)) {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in expression`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private isOp(t: Token | undefined, v: string): boolean {
    return !!t && t.type === "op" && t.value === v;
  }

  parse(): number {
    const value = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}`);
    }
    return value;
  }

  private parseExpr(): number {
    let value = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (this.isOp(t, "+") || this.isOp(t, "-")) {
        const op = this.next() as Token & { type: "op" };
        const rhs = this.parseTerm();
        value = op.value === "+" ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (true) {
      const t = this.peek();
      if (this.isOp(t, "*") || this.isOp(t, "/")) {
        const op = this.next() as Token & { type: "op" };
        const rhs = this.parsePower();
        if (op.value === "/") {
          if (rhs === 0) throw new Error("Division by zero");
          value = value / rhs;
        } else {
          value = value * rhs;
        }
      } else break;
    }
    return value;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    if (this.isOp(this.peek(), "^")) {
      this.next();
      const exponent = this.parsePower(); // right-associative
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (this.isOp(t, "-") || this.isOp(t, "+")) {
      const op = this.next() as Token & { type: "op" };
      return op.value === "-" ? -this.parseUnary() : this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): number {
    let value = this.parsePrimary();
    while (this.isOp(this.peek(), "%")) {
      this.next();
      value = value / 100;
    }
    return value;
  }

  private parsePrimary(): number {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "num") return t.value;
    if (t.type === "op" && t.value === "(") {
      const value = this.parseExpr();
      const close = this.next();
      if (!close || close.type !== "op" || close.value !== ")") {
        throw new Error("Expected closing parenthesis");
      }
      return value;
    }
    throw new Error(`Unexpected token '${t.value}'`);
  }
}

export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error("Empty expression");
  const result = new Parser(tokens).parse();
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number");
  return result;
}
