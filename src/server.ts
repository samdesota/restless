import * as path from "path";
import { json } from "body-parser";
import * as t from "io-ts";
import * as fp from "fp-ts";
import * as PathReporter from "io-ts/lib/PathReporter";
import { HTTPError, HTTPRedirect } from "./errors";

export * from "./errors";


export interface MethodDescription<Params extends t.Any, Result, Ctx extends { [key: string]: (req: any) => any }> {
  params?: Params;
  context?: Ctx;
  handler: (params: t.TypeOf<Params>, ctx: {[key in keyof Ctx]: Ctx[key] extends (value: any) => infer ret ? ret : never}) => Promise<Result> | Result;
}

const memoMap = new WeakMap();
const selectRequestContext = async <R>(
  request: any,
  method: (request: any) => Promise<R> | R
): Promise<R> => {
  if (!memoMap.has(request)) {
    memoMap.set(request, new Map());
  }

  const selections = memoMap.get(request);

  if (!selections.has(method)) {
    selections.set(method, await method(request));
  }

  return selections.get(method);
};

export const method = <R, Ctx extends { [key: string]: (req: any) => any }, P extends t.Any = t.NeverC>(
  description: MethodDescription<P, R, Ctx>
) => {
  return ((async (...args) => {
    let params: any;
    let request: any;

    if (args.length > 1) {
      params = args[0];
      request = args[1];
    } else {
      params = {};
      request = args[0];
    }

    if (request == null) {
      throw new Error(
        `Expected request to be passed to restless methods when used on the server.`
      );
    }

    if (description.params != null) {
      const result = description.params.decode(params);
      const correct = fp.function.pipe(
        result,
        fp.either.mapLeft((error) => {
          const errors = PathReporter.failure(error);
          throw new Error(`Data Error:\n${errors.join("\n")}`);
        })
      );

      params = fp.either.isRight(correct) ? correct.right : null;
    }

    const ctx =
      description.context != null
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(description.context).map(
                async ([key, selectContext]) => {
                  return [
                    key,
                    await selectRequestContext(request, selectContext as any),
                  ];
                }
              )
            )
          )
        : {};

    return description.handler(params, ctx as any);
  }) as any) as P extends t.NeverC
    ? (request?: Ctx[keyof Ctx] extends (arg: infer arg) => any ? arg : never) => Promise<R>
    : (params: t.TypeOf<P>, request?: Ctx[keyof Ctx] extends (arg: infer arg) => any ? arg : never) => Promise<R>;
};

export interface RestlessOptions {
  namespace: string;

  getAPIModule: (moduleName: string) => any;
}

export const getMethodResponse = async (
  { getAPIModule, namespace }: RestlessOptions,
  request,
  req
) => {
  const args = request.args == null ? {} : request.args;

  if (typeof request.id !== "string") {
    throw new Error(`unexpected _rpc request body ${JSON.stringify(request)}`);
  }

  const method = path.basename(request.id);
  const moduleId = path.dirname(request.id);

  const moduleName = `${moduleId}.${namespace}.ts`;
  const moduleObject = await getAPIModule(moduleName);

  return (await moduleObject[method](args, req)) ?? null;
};

export const socket = (options: RestlessOptions) => {
  return {
    idleTimeout: 30,

    open(ws) {
      ws.on("message", () => {});
    },
  };
};

export const middleware = (options: RestlessOptions) => {
  return [
    json(),
    async (req, res, next) => {
      const request = req.body;

      try {
        const result = await getMethodResponse(options, request, req);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e instanceof HTTPError) {
          console.error(e);
          res.writeHead(e.status);
          res.end(JSON.stringify({ message: e.message }));
        } else {
          console.error(e);
          res.writeHead(500);
          res.end("Internal error");
        }
      }
    },
  ];
};
