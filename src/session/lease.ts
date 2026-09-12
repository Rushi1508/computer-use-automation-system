/**
 * Who controls the live session — enforced, not advisory.
 *
 * Handing a running automation to a person is a concurrency problem before it
 * is a UI problem. Two parties driving one browser at once produce exactly the
 * failure a bank cannot afford: automation clicks "Open Account" on a screen the
 * operator has just changed. So control is a lease with an explicit state
 * machine, and every observation or action on the session is checked against it:
 *
 *   automation --requestHuman--> pending_human --claim--> human
 *       ^                              |                    |
 *       |                          withdraw          release / revoke
 *       |                              v                    v
 *       +-------resumeAutomation--- resuming <--------------+
 *
 * Nobody holds the session while it is pending or resuming, so the pause is not
 * a courtesy: automation cannot act until a person has claimed, worked, and
 * released, and automation has explicitly taken control back. The generation
 * number increments whenever control changes hands, which gives every
 * transition in the evidence an unambiguous order.
 *
 * Screenshots are exempt. They do not change the session, and a person deciding
 * whether to claim an intervention needs to see the screen first.
 */

import type { Action, ActResult, Observation, Surface } from "../perception/types.js";

export type LeaseState = "automation" | "pending_human" | "human" | "resuming";

export interface Actor {
  readonly kind: "automation" | "operator";
  readonly id: string;
}

export interface LeaseTransition {
  readonly at: string;
  readonly from: LeaseState;
  readonly to: LeaseState;
  /** Who controls the session after the transition. Null while paused. */
  readonly holder: Actor | null;
  readonly generation: number;
  readonly reason: string;
}

export class LeaseViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseViolation";
  }
}

export class SessionLease {
  readonly automation: Actor;
  #state: LeaseState = "automation";
  #holder: Actor | null;
  #generation = 0;
  readonly #transitions: LeaseTransition[] = [];
  readonly #listeners = new Set<(transition: LeaseTransition) => void>();

  constructor(automation: Actor = { kind: "automation", id: "automation" }) {
    this.automation = automation;
    this.#holder = automation;
  }

  get state(): LeaseState {
    return this.#state;
  }

  get holder(): Actor | null {
    return this.#holder;
  }

  get generation(): number {
    return this.#generation;
  }

  get transitions(): readonly LeaseTransition[] {
    return this.#transitions;
  }

  onTransition(listener: (transition: LeaseTransition) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Automation pauses and asks for a person. It gives up control while it waits. */
  requestHuman(reason: string): void {
    this.#expect("automation", "request a person");
    this.#move("pending_human", null, reason);
  }

  /** A person takes control of the paused session. */
  claim(operatorId: string, reason: string): void {
    this.#expect("pending_human", "claim the session");
    this.#generation++;
    this.#move("human", { kind: "operator", id: operatorId }, reason);
  }

  /** The person hands the session back. Only the person holding it can. */
  release(operatorId: string, reason: string): void {
    this.#expect("human", "release the session");
    if (this.#holder?.id !== operatorId) {
      throw new LeaseViolation(`operator '${operatorId}' does not hold the session; '${this.#holder?.id ?? "nobody"}' does`);
    }
    this.#move("resuming", null, reason);
  }

  /** A request nobody claimed is withdrawn, for example on timeout. */
  withdraw(reason: string): void {
    this.#expect("pending_human", "withdraw the request");
    this.#move("resuming", null, reason);
  }

  /** Control is taken back from a person who did not release it, for example on timeout. */
  revoke(reason: string): void {
    this.#expect("human", "revoke the session");
    this.#move("resuming", null, reason);
  }

  /** Automation takes control again, after its handback checks. */
  resumeAutomation(reason: string): void {
    this.#expect("resuming", "resume automation");
    this.#generation++;
    this.#move("automation", this.automation, reason);
  }

  isHeldBy(actor: Actor): boolean {
    return this.#holder !== null && this.#holder.kind === actor.kind && this.#holder.id === actor.id;
  }

  assertControl(actor: Actor): void {
    if (this.isHeldBy(actor)) return;
    const holder = this.#holder === null ? "nobody holds it" : `held by ${this.#holder.kind} '${this.#holder.id}'`;
    throw new LeaseViolation(
      `${actor.kind} '${actor.id}' does not control the session (state ${this.#state}, ${holder})`,
    );
  }

  #expect(state: LeaseState, operation: string): void {
    if (this.#state !== state) {
      throw new LeaseViolation(`cannot ${operation} while the session is '${this.#state}'`);
    }
  }

  #move(to: LeaseState, holder: Actor | null, reason: string): void {
    const transition: LeaseTransition = {
      at: new Date().toISOString(),
      from: this.#state,
      to,
      holder,
      generation: this.#generation,
      reason,
    };
    this.#state = to;
    this.#holder = holder;
    this.#transitions.push(transition);
    for (const listener of this.#listeners) listener(transition);
  }
}

/**
 * A view of a Surface bound to one actor. Every observation and action is
 * checked against the lease, so "who is in control" cannot be ignored by a code
 * path that forgot to ask.
 *
 * Observation is guarded as well as action: observing disposes the previous
 * observation's element handles, so an operator refreshing their view would
 * silently invalidate the node ids automation was about to act on.
 */
export class LeasedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly lease: SessionLease,
    private readonly actor: Actor,
  ) {}

  async observe(): Promise<Observation> {
    this.lease.assertControl(this.actor);
    return this.inner.observe();
  }

  async act(action: Action): Promise<ActResult> {
    this.lease.assertControl(this.actor);
    return this.inner.act(action);
  }

  async screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }

  async close(): Promise<void> {
    this.lease.assertControl(this.actor);
    return this.inner.close();
  }
}
