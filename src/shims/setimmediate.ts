// Replaces the "setimmediate" polyfill that jszip loads for utils.delay(). Like the original, it
// only installs window.setImmediate when the environment has none (Obsidian desktop already has
// Node's setImmediate). Unlike the original it never builds <script> elements and never turns a
// string into code with new Function: callbacks must be functions, which is all jszip passes.
// MessageChannel gives the same "after the current task, before timers" ordering as the
// original postMessage path; window.setTimeout is the fallback.
type Task = { fn: (...args: unknown[]) => void; args: unknown[] };
interface ImmediateHost { setImmediate?: unknown; clearImmediate?: unknown }

const host = window as unknown as ImmediateHost;
if (typeof host.setImmediate !== 'function') {
	let next = 1;
	const tasks = new Map<number, Task>();
	const run = (handle: number) => {
		const task = tasks.get(handle);
		if (!task) return;
		tasks.delete(handle);
		task.fn(...task.args);
	};
	let schedule: (handle: number) => void;
	if (typeof MessageChannel === 'function') {
		const ch = new MessageChannel();
		ch.port1.onmessage = (e: MessageEvent<number>) => run(e.data);
		schedule = (h) => ch.port2.postMessage(h);
	} else {
		schedule = (h) => { window.setTimeout(() => run(h), 0); };
	}
	host.setImmediate = (fn: unknown, ...args: unknown[]): number => {
		if (typeof fn !== 'function') throw new TypeError('setImmediate expects a function');
		const h = next++;
		tasks.set(h, { fn: fn as Task['fn'], args });
		schedule(h);
		return h;
	};
	host.clearImmediate = (h: number) => { tasks.delete(h); };
}
