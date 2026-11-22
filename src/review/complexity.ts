/**
 * The functions of a source file, each with its cyclomatic complexity and the lines of its
 * statements.
 *
 * **Cyclomatic complexity** is the number of independent paths through a function: 1, plus one
 * for each place the path can fork. The forks counted here are `if`, `?:`, each loop, each `case`
 * that is not `default`, `catch`, and the short-circuit operators `&&`, `||` and `??` (with their
 * assignment forms). This is McCabe's count as most tools take it for JavaScript.
 *
 * **A nested function is its own function.** Its forks do not count towards the function that
 * holds it, and its statements are not the holder's statements. A callback passed to `map` is
 * measured on its own line, so a short function with one long callback does not look complex.
 *
 * The statement lines are what the coverage reader needs: Node reports a count for every line of a
 * file, comments included, so "how much of this function ran" is asked of these lines only.
 */

import ts from "typescript";

export interface FunctionInfo {
  /** A name a person can find: `name`, `Class.method`, or `(anonymous)` for a bare callback. */
  name: string;
  /** First and last line, 1-based. */
  line: number;
  endLine: number;
  complexity: number;
  /** The 1-based line of each statement this function holds, nested functions excluded. */
  statementLines: number[];
}

const FORKS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUIT = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

type FunctionNode =
  | ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
  | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

/** A node that is a statement in its own right. A block only groups statements, so it is not one. */
function isStatement(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement
    && node.kind !== ts.SyntaxKind.Block;
}

function nameOf(node: FunctionNode, file: ts.SourceFile): string {
  const own = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
    || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
  if (ts.isConstructorDeclaration(node)) return `${className(node)}.constructor`;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const owner = className(node);
    return owner ? `${owner}.${own ?? "(computed)"}` : (own ?? "(computed)");
  }
  if (own) return own;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return `${className(parent) ?? ""}.${parent.name.text}`.replace(/^\./, "");
  }
  return `(anonymous, line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1})`;
}

function className(node: ts.Node): string | undefined {
  const owner = node.parent;
  return owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.name
    ? owner.name.text : undefined;
}

/** Every function in `source`, in source order. `fileName` is used for messages and parsing mode only. */
export function functionsOf(fileName: string, source: string): FunctionInfo[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const found: FunctionInfo[] = [];

  const measure = (fn: FunctionNode): void => {
    if (!fn.body) return; // an overload or an abstract method: no code of its own
    let complexity = 1;
    const lines = new Set<number>();

    const walk = (node: ts.Node): void => {
      if (isFunction(node)) {
        measure(node);
        return;
      }
      if (FORKS.has(node.kind)) complexity++;
      if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.has(node.operatorToken.kind)) complexity++;
      if (isStatement(node)) lines.add(lineOf(node.getStart(file)));
      ts.forEachChild(node, walk);
    };

    if (ts.isBlock(fn.body)) {
      ts.forEachChild(fn.body, walk);
    } else {
      // An arrow with an expression body has no statements, so its one line is the expression's.
      lines.add(lineOf(fn.body.getStart(file)));
      walk(fn.body);
    }

    found.push({
      name: nameOf(fn, file),
      line: lineOf(fn.getStart(file)),
      endLine: lineOf(fn.getEnd()),
      complexity,
      statementLines: [...lines].sort((a, b) => a - b),
    });
  };

  const top = (node: ts.Node): void => {
    if (isFunction(node)) measure(node);
    else ts.forEachChild(node, top);
  };
  top(file);

  return found.sort((a, b) => a.line - b.line);
}
