type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>) {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<Events[K]>)(payload);
      } catch (err) {
        console.error(`[emitter] ${String(event)} handler failed`, err);
      }
    }
  }
}
