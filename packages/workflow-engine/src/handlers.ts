import type { NodeHandler } from "./types.js";

/** Maps node `type` strings to their handlers. */
export class NodeHandlerRegistry {
  private readonly handlers = new Map<string, NodeHandler>();

  constructor(entries?: Record<string, NodeHandler>) {
    if (entries) for (const [type, handler] of Object.entries(entries)) this.register(type, handler);
  }

  register(type: string, handler: NodeHandler): this {
    if (this.handlers.has(type)) throw new Error(`Handler already registered for node type "${type}"`);
    this.handlers.set(type, handler);
    return this;
  }

  /** Registers or replaces a handler. */
  set(type: string, handler: NodeHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
