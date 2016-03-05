var assert = require("assert");
var fiberPool = require("./fiber_pool.js").makePool();
//var MeteorPromise = require("./promise.js");
var asap = require('asap');

// Replace MeteorPromise.prototype.then with a wrapper that ensures the
// onResolved and onRejected callbacks always run in a Fiber.
var es6PromiseThen = Promise.prototype.then;
Promise.prototype.then = function (onResolved, onRejected) {
  var promise = this.constructor;

  if (typeof promise.Fiber === "function") {
    var fiber = promise.Fiber.current;
    var dynamics = cloneFiberOwnProperties(fiber);

    return es6PromiseThen.call(
      this,
      wrapCallback(onResolved, promise, dynamics),
      wrapCallback(onRejected, promise, dynamics)
    );
  }

  return es6PromiseThen.call(this, onResolved, onRejected);
};

function wrapCallback(callback, promise, dynamics) {
  if (! callback) {
    return callback;
  }

  return function (arg) {
    return fiberPool.run({
      callback: callback,
      args: [arg], // Avoid dealing with arguments objects.
      dynamics: dynamics
    }, promise);
  };
}

function cloneFiberOwnProperties(fiber) {
  if (fiber) {
    var dynamics = {};

    Object.keys(fiber).forEach(function (key) {
      dynamics[key] = shallowClone(fiber[key]);
    });

    return dynamics;
  }
}

function shallowClone(value) {
  if (Array.isArray(value)) {
    return value.slice(0);
  }

  if (value && typeof value === "object") {
    var copy = Object.create(Object.getPrototypeOf(value));
    var keys = Object.keys(value);
    var keyCount = keys.length;

    for (var i = 0; i < keyCount; ++i) {
      var key = keys[i];
      copy[key] = value[key];
    }

    return copy;
  }

  return value;
}

// Yield the current Fiber until the given Promise has been fulfilled.
function await(promise) {
  var newPromise = Promise.constructor;
  var fiber = Promise.Fiber;

  assert.strictEqual(
    typeof fiber, "function",
    "Cannot await unless Promise.Fiber is defined"
  );

  var currentFiber = fiber.current;

  assert.ok(
    currentFiber instanceof fiber,
    "Cannot await without a Fiber"
  );

  var run = currentFiber.run;
  var throwInto = currentFiber.throwInto;

  if (process.domain) {
    run = process.domain.bind(run);
    throwInto = process.domain.bind(throwInto);
  }

  // The overridden es6PromiseThen function is adequate here because these
  // two callbacks do not need to run in a Fiber.
  es6PromiseThen.call(promise, function (result) {
    tryCatchNextTick(currentFiber, run, [result]);
  }, function (error) {
    tryCatchNextTick(currentFiber, throwInto, [error]);
  });

  return fiber.yield();
}

// Invoke method with args against object in a try-catch block,
// re-throwing any exceptions in the next tick of the event loop, so that
// they won't get captured/swallowed by the caller.
function tryCatchNextTick(object, method, args) {
  try {
    return method.apply(object, args);
  } catch (error) {
    process.nextTick(function () {
      throw error;
    });
  }
}

Promise.awaitAll = function (args) {
  return await(this.all(args));
};

Promise.await = function (arg) {
  return await(this.resolve(arg));
};

Promise.prototype.await = function () {
  return await(this);
};

// Return a wrapper function that returns a Promise for the eventual
// result of the original function.
Promise.async = function (fn, allowReuseOfCurrentFiber) {
  var promise = this;
  return function () {
    return promise.asyncApply(
      fn, this, arguments,
      allowReuseOfCurrentFiber
    );
  };
};

Promise.asyncApply = function (
  fn, context, args, allowReuseOfCurrentFiber
) {
  var promise = this;
  var currentFiber = promise.Fiber && promise.Fiber.current;

  if (currentFiber && allowReuseOfCurrentFiber) {
    return this.resolve(fn.apply(context, args));
  }

  return fiberPool.run({
    callback: fn,
    context: context,
    args: args,
    dynamics: cloneFiberOwnProperties(currentFiber)
  }, promise);
};

Function.prototype.async = function (allowReuseOfCurrentFiber) {
  return Promise.async(this, allowReuseOfCurrentFiber);
};

Function.prototype.asyncApply = function (
  context, args, allowReuseOfCurrentFiber
) {
  return Promise.asyncApply(
    this, context, args, allowReuseOfCurrentFiber
  );
};
Promise.denodeify = function (fn, argumentCount) {
  argumentCount = argumentCount || Infinity;
  return function () {
    var self = this;
    var args = Array.prototype.slice.call(arguments, 0,
        argumentCount > 0 ? argumentCount : 0);
    return new Promise(function (resolve, reject) {
      args.push(function (err, res) {
        if (err) reject(err);
        else resolve(res);
      })
      var res = fn.apply(self, args);
      if (res &&
        (
          typeof res === 'object' ||
          typeof res === 'function'
        ) &&
        typeof res.then === 'function'
      ) {
        resolve(res);
      }
    })
  }
}
Promise.nodeify = function (fn) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var callback =
      typeof args[args.length - 1] === 'function' ? args.pop() : null;
    var ctx = this;
    try {
      return fn.apply(this, arguments).nodeify(callback, ctx);
    } catch (ex) {
      if (callback === null || typeof callback == 'undefined') {
        return new Promise(function (resolve, reject) {
          reject(ex);
        });
      } else {
        asap(function () {
          callback.call(ctx, ex);
        })
      }
    }
  }
}

Promise.prototype.nodeify = function (callback, ctx) {
  if (typeof callback != 'function') return this;

  this.then(function (value) {
    asap(function () {
      callback.call(ctx, null, value);
    });
  }, function (err) {
    asap(function () {
      callback.call(ctx, err);
    });
  });
}

module.exports = exports = Promise;
