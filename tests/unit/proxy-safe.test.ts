// #545: the proxy-receiver hazard and the binding that defeats it. The FIRST row proves the
// hazard is real (an ES private method on a Proxy receiver throws exactly the message the
// maintainer's popup carried); the rest prove bindPublicMethods defeats it for methods,
// inherited chains, and accessors — and stops at the Service boundary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bindPublicMethods } from '../../src/proxy-safe.ts'

import { Service } from '@deepseek-ai/cordis'
// the REAL cordis Service is the boundary the helper stops at — a local stand-in would
// not match its prototype and the walk would sail past it (measured on the first cut).
class FrameworkShim extends Service { lifecycle() { return 'framework' } } // extends the REAL cordis Service: the walk must stop at its prototype
class EngineLike {
  #brand = 42
  read() { return this.#brand }
  get viaAccessor() { return this.#brand }
}
class Sub extends EngineLike {
  #extra = 'sub'
  both() { return `${this.#extra}:${this.read()}` }
}

test('#545 hazard proof: an unbound ES-private method throws the receiver TypeError through a Proxy', () => {
  const raw = new Sub()
  const proxy = new Proxy(raw, {})
  assert.throws(() => proxy.read(), (error: unknown) => /Receiver must be an instance|incompatible receiver|private member/i.test(String(error)))
})

test('#545: bindPublicMethods makes the same proxy call succeed — methods, brands, and accessors', () => {
  const raw = new Sub()
  bindPublicMethods(raw)
  const proxy = new Proxy(raw, {})
  assert.equal(proxy.read(), 42, 'base-class private method survives the proxy')
  assert.equal(proxy.both(), 'sub:42', 'private access across BOTH classes of the chain')
  assert.equal(proxy.viaAccessor, 42, 'accessors re-bound too')
})

test('#545: the walk stops at the REAL cordis Service boundary', () => {
  class Mid extends FrameworkShim { fork() { return 'mid' } }
  class PluginService extends Mid { start() { return 'host-called' } }
  // no construction: the helper only reads the chain and writes own properties.
  const raw = Object.create(PluginService.prototype) as Record<string, unknown> & PluginService
  bindPublicMethods(raw)
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'start'), true, 'plugin methods bind')
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'fork'), true, 'and so do intermediate classes below the boundary')
  assert.equal(new Proxy(raw, {}).start(), 'host-called')
})

test('#545 override protection: a base-class method never shadows the subclass wrapper (first-writer wins)', () => {
  class Base extends FrameworkShim { decide() { return 'base' } }
  class Derived extends Base { override decide() { return 'derived' } }
  const raw = Object.create(Derived.prototype) as unknown as Derived
  bindPublicMethods(raw)
  assert.equal(new Proxy(raw, {}).decide(), 'derived', 'the most-derived implementation wins the wrapper')
  // and late prototype stubs (the engine tests' double style) still take effect:
  Derived.prototype.decide = () => 'stubbed'
  assert.equal(new Proxy(raw, {}).decide(), 'stubbed', 'late dispatch, not captured bind')
})

test('#545: binding is idempotent — a second call changes nothing observable', () => {
  const raw = new Sub()
  bindPublicMethods(raw)
  const first = raw.read
  bindPublicMethods(raw)
  assert.equal(new Proxy(raw, {}).read(), 42)
  assert.equal(typeof first, 'function')
})
