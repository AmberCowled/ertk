# ERTK — Easy RTK

Define endpoints once, generate RTK Query hooks and Next.js route handlers automatically.

ERTK is a TypeScript code generation tool that eliminates the boilerplate of writing RTK Query APIs and Next.js App Router route handlers. You define your endpoints in simple, type-safe files — ERTK generates the rest.

## Features

- **Single source of truth** — Define each endpoint once with its name, method, validation, tags, and handler
- **RTK Query codegen** — Generates a fully typed `api.ts` with `createApi`, hooks, and cache tag configuration
- **Redux store scaffolding** — Generates a ready-to-use `store.ts` with the API middleware wired up
- **Next.js App Router routes** — Generates `route.ts` files that map HTTP methods to your handlers
- **Cache invalidation helpers** — Generates `invalidation.ts` with re-exported utilities
- **Optimistic updates** — Declarative single and multi-target optimistic update configuration
- **Validation** — Works with Zod (v3 & v4), Valibot, ArkType, or any schema with a `.parse()` method
- **Auth adapters** — Pluggable authentication via a simple `getUser(req)` interface
- **Incremental builds** — Manifest-based change detection skips generation when nothing changed
- **Watch mode** — Watches endpoint files and regenerates on save with 300ms debouncing
- **Path alias detection** — Auto-reads `tsconfig.json` paths to generate correct import paths
- **Custom error handlers** — Chainable error handlers for ORM-specific or domain errors
- **Per-endpoint retries** — Configurable `maxRetries` with exponential backoff via RTK Query's native `retry` utility
- **Server-side rate limiting** — Pluggable rate limiting for route handlers with in-memory default and adapter interface for distributed stores (Redis, Upstash, etc.)

## Installation

```bash
npm install ertk
# or
pnpm add ertk
# or
yarn add ertk
```

### Peer Dependencies

ERTK requires the following peer dependencies:

| Package | Version | Required |
|---------|---------|----------|
| `@reduxjs/toolkit` | `^2.0.0` | Yes |
| `react` | `>=18.0.0` | Yes |
| `react-redux` | `^9.0.0` | Yes |
| `typescript` | `^5.0.0` | Yes |
| `next` | `>=14.0.0` | Only for route generation |
| `zod` | `^3.0.0 \|\| ^4.0.0` | Only if using Zod validation |

## Quick Start

### 1. Initialize your project

```bash
npx ertk init
```

This creates:
- `ertk.config.ts` — Configuration file
- `src/endpoints/` — Directory for endpoint definitions
- `src/generated/` — Directory for generated output

### 2. Define an endpoint

```typescript
// src/endpoints/tasks/list.ts
import { endpoint } from "ertk";
import type { Task } from "@app/types/task";

export default endpoint.get<Task[]>({
  name: "listTasks",
  protected: true,
  query: () => "/tasks",
  tags: {
    provides: ["Tasks"],
  },
  handler: async ({ user }) => {
    return await db.task.findMany({ where: { userId: user.id } });
  },
});
```

### 3. Generate

```bash
npx ertk generate
```

### 4. Use the generated hooks

```tsx
import { useListTasksQuery } from "@app/generated/api";

function TaskList() {
  const { data: tasks, isLoading } = useListTasksQuery();

  if (isLoading) return <p>Loading...</p>;

  return (
    <ul>
      {tasks?.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}
```

## CLI

```
ertk — Easy RTK Query codegen

Usage:
  ertk generate          One-shot generation (skips if nothing changed)
  ertk generate --watch  Watch mode with incremental regeneration
  ertk init              Scaffold config file and directories
  ertk --help            Show this help message

Options:
  --watch    Watch for endpoint file changes and regenerate
  --help     Show help
```

### `ertk init`

Scaffolds the project structure. Creates `ertk.config.ts` and the `src/endpoints/` and `src/generated/` directories if they don't exist.

### `ertk generate`

Runs a one-shot generation. Compares an MD5 manifest of all endpoint files against the previous run and skips generation if nothing has changed.

### `ertk generate --watch`

Runs an initial full build, then watches the endpoints directory for file changes. Uses a 300ms debounce to batch rapid saves. When an endpoint file is modified, only that file is re-parsed and the full output is regenerated.

## Configuration

Create an `ertk.config.ts` (or `.mts`, `.js`, `.mjs`) in your project root:

```typescript
import { defineConfig } from "ertk";

export default defineConfig({
  // Directory containing endpoint definition files
  endpoints: "src/endpoints",

  // Directory for generated output (api.ts, store.ts, invalidation.ts)
  generated: "src/generated",

  // Base URL for RTK Query fetchBaseQuery
  baseUrl: "/api",

  // Route generation config (omit entirely to skip route generation)
  routes: {
    dir: "src/app/api",
    handlerModule: "ertk/next",
    ignoredRoutes: ["auth"],
  },
});
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoints` | `string` | `"src/endpoints"` | Directory containing endpoint definition files |
| `generated` | `string` | `"src/generated"` | Directory for generated output files |
| `baseUrl` | `string` | `"/api"` | Base URL for `fetchBaseQuery` |
| `baseQuery` | `string` | — | Custom `baseQuery` source code (overrides `baseUrl`) |
| `pathAlias` | `string` | auto-detected | Path alias prefix (e.g., `"@app"`, `"@src"`) |
| `crudFilenames` | `string[]` | see below | Filenames that map to CRUD operations |
| `routes` | `object \| undefined` | — | Route generation config; omit to skip |

**Default CRUD filenames:** `["get", "list", "create", "update", "delete", "send", "remove", "cancel"]`

CRUD filenames determine which endpoint filenames become URL segments and which don't. For example, `src/endpoints/tasks/list.ts` generates the route `/api/tasks` (not `/api/tasks/list`) because `list` is a CRUD filename.

### Route Generation Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `routes.dir` | `string` | — | Directory where Next.js route files are generated |
| `routes.handlerModule` | `string` | `"ertk/next"` | Module that exports `createRouteHandler` |
| `routes.ignoredRoutes` | `string[]` | `[]` | Top-level route directories to skip |

### Custom `baseQuery`

For full control over fetch configuration (auth headers, base URLs, etc.):

```typescript
export default defineConfig({
  baseQuery: `fetchBaseQuery({
    baseUrl: "https://api.example.com",
    prepareHeaders: (headers) => {
      headers.set("Authorization", \`Bearer \${getToken()}\`);
      return headers;
    },
  })`,
});
```

### Path Alias Auto-Detection

ERTK automatically reads your `tsconfig.json` to detect path aliases. If you have:

```json
{
  "compilerOptions": {
    "paths": {
      "@app/*": ["./src/*"]
    }
  }
}
```

ERTK will use `@app` as the import prefix in generated files. If no alias is found, it defaults to `@app` with a `src` root.

## Endpoint Definitions

Endpoints are defined using the `endpoint` factory, which provides methods for each HTTP verb:

```typescript
import { endpoint } from "ertk";

// Available methods
endpoint.get<ResponseType, ArgsType>({ ... })
endpoint.post<ResponseType, ArgsType>({ ... })
endpoint.put<ResponseType, ArgsType>({ ... })
endpoint.patch<ResponseType, ArgsType>({ ... })
endpoint.delete<ResponseType, ArgsType>({ ... })
```

Each file should have a single `default export` of an endpoint definition.

### Endpoint Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | — | **Required.** Name for the generated hook (e.g., `"getTasks"` becomes `useGetTasksQuery`) |
| `protected` | `boolean` | `true` | Whether the endpoint requires authentication |
| `query` | `(args) => string \| { url, method?, body? }` | — | Client-side query function for RTK Query |
| `request` | `ValidationSchema` | — | Request validation schema (Zod, Valibot, etc.) |
| `tags` | `{ provides?, invalidates? }` | — | RTK Query cache tag configuration |
| `optimistic` | `SingleOptimistic \| MultiOptimistic` | — | Optimistic update configuration |
| `maxRetries` | `number` | — | Max client-side retry attempts for transient failures (5xx, network errors) |
| `rateLimit` | `{ windowMs: number; max: number }` | — | Per-endpoint server-side rate limit override |
| `handler` | `(ctx) => Promise<unknown>` | — | Server-side handler (omit for client-only endpoints) |

### GET Endpoint (Query)

```typescript
// src/endpoints/tasks/get.ts
import { endpoint } from "ertk";
import type { Task } from "@app/types/task";

export default endpoint.get<Task, { id: string }>({
  name: "getTask",
  protected: true,
  query: ({ id }) => `/tasks/${id}`,
  tags: {
    provides: (result, _error, { id }) => [{ type: "Tasks", id }],
  },
  handler: async ({ query, user }) => {
    return await db.task.findUnique({
      where: { id: query.id, userId: user.id },
    });
  },
});
```

### POST Endpoint (Mutation)

```typescript
// src/endpoints/tasks/create.ts
import { endpoint } from "ertk";
import { z } from "zod";
import type { Task, CreateTaskInput } from "@app/types/task";

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

export default endpoint.post<Task, CreateTaskInput>({
  name: "createTask",
  protected: true,
  request: createTaskSchema,
  query: (body) => ({ url: "/tasks", method: "POST", body }),
  tags: {
    invalidates: ["Tasks"],
  },
  handler: async ({ body, user }) => {
    return await db.task.create({
      data: { ...body, userId: user.id },
    });
  },
});
```

### Client-Only Endpoint (No Handler)

For endpoints that consume an external API (no server-side handler needed):

```typescript
// src/endpoints/weather/get.ts
import { endpoint } from "ertk";
import type { WeatherData } from "@app/types/weather";

export default endpoint.get<WeatherData, { city: string }>({
  name: "getWeather",
  protected: false,
  query: ({ city }) => `/weather?city=${city}`,
});
```

Client-only endpoints (no `handler`) are excluded from route generation but are still included in the generated RTK Query API.

### Retries

Add `maxRetries` to any endpoint to automatically retry on transient failures (5xx, network errors, 408, 429). ERTK uses RTK Query's built-in `retry` utility with exponential backoff.

```typescript
// src/endpoints/user/xp/get.ts
import { endpoint } from "ertk";
import type { GetXPResponse } from "@app/types/xp";

export default endpoint.get<GetXPResponse, void>({
  name: "getXP",
  tags: { provides: ["XP"] },
  protected: true,
  maxRetries: 2,
  query: () => "/user/xp",
  handler: async ({ user }) => {
    const xp = await getXP(user.id);
    return { xp };
  },
});
```

With `maxRetries: 2`, the client will make up to 3 total attempts (1 initial + 2 retries) with exponential backoff. Only transient errors trigger retries — 4xx client errors (400, 401, 403, 404) are never retried.

When any endpoint uses `maxRetries`, the generated `api.ts` wraps the base query with RTK Query's `retry()` utility and emits `extraOptions` on the relevant endpoints:

```typescript
// Generated api.ts
import { createApi, fetchBaseQuery, retry } from "@reduxjs/toolkit/query/react";

export const api = createApi({
  reducerPath: "api",
  baseQuery: retry(fetchBaseQuery({ baseUrl: "/api" }), { maxRetries: 0 }),
  endpoints: (builder) => ({
    getXP: builder.query<GetXPResponse, void>({
      query: () => "/user/xp",
      providesTags: ["XP"],
      extraOptions: { maxRetries: 2 },
    }),
  }),
});
```

Endpoints without `maxRetries` are unaffected — the global default is 0 retries. If no endpoint uses retries, the generated output is identical to the standard `fetchBaseQuery` without `retry`.

### File Structure and Route Mapping

Endpoint file paths map to API routes. CRUD filenames (configurable) are stripped from the URL:

| File Path | Route |
|-----------|-------|
| `src/endpoints/tasks/list.ts` | `/api/tasks` |
| `src/endpoints/tasks/create.ts` | `/api/tasks` |
| `src/endpoints/tasks/get.ts` | `/api/tasks` |
| `src/endpoints/users/profile/update.ts` | `/api/users/profile` |
| `src/endpoints/billing/invoices.ts` | `/api/billing/invoices` |

Multiple endpoints that resolve to the same route are grouped into a single `route.ts` file, each exported as the appropriate HTTP method (`GET`, `POST`, `PUT`, etc.).

## Generated Output

Running `ertk generate` produces the following files:

### `api.ts`

The RTK Query API definition with all endpoints and exported hooks:

```typescript
// AUTO-GENERATED by ERTK codegen. Do not edit.
import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Task } from "@app/types/task";

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Tasks"],
  refetchOnFocus: false,
  refetchOnReconnect: true,
  endpoints: (builder) => ({
    listTasks: builder.query<Task[], void>({
      query: () => "/tasks",
      providesTags: ["Tasks"],
    }),
    createTask: builder.mutation<Task, CreateTaskInput>({
      query: (body) => ({ url: "/tasks", method: "POST", body }),
      invalidatesTags: ["Tasks"],
    }),
  }),
});

export const {
  useListTasksQuery,
  useCreateTaskMutation,
} = api;
```

### `store.ts`

A pre-configured Redux store:

```typescript
// AUTO-GENERATED by ERTK codegen. Do not edit.
import { configureStore } from "@reduxjs/toolkit";
import { api } from "./api";

export const store = configureStore({
  reducer: {
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(api.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

### `invalidation.ts`

Cache invalidation helper re-exports:

```typescript
// AUTO-GENERATED by ERTK codegen. Do not edit.
import { api } from "./api";

export function invalidateTags(
  ...args: Parameters<typeof api.util.invalidateTags>
) {
  return api.util.invalidateTags(...args);
}

export const updateQueryData = api.util.updateQueryData;
```

### Route Files (Next.js)

Generated in your configured routes directory (e.g., `src/app/api/tasks/route.ts`):

```typescript
// AUTO-GENERATED by ERTK codegen. Do not edit.
import { createRouteHandler } from "ertk/next";
import listTasksEndpoint from "@app/endpoints/tasks/list";
import createTaskEndpoint from "@app/endpoints/tasks/create";

export const GET = createRouteHandler(listTasksEndpoint);
export const POST = createRouteHandler(createTaskEndpoint);
```

## Next.js Route Handlers

### Setting Up Auth

For protected endpoints, configure an auth adapter:

```typescript
// src/lib/ertk-handler.ts
import { configureHandler } from "ertk/next";
import { getServerSession } from "next-auth";
import { authOptions } from "@app/lib/auth";
import { db } from "@app/lib/db";

export const createRouteHandler = configureHandler({
  auth: {
    getUser: async (req) => {
      const session = await getServerSession(authOptions);
      if (!session?.user?.email) return null;
      return await db.user.findUnique({
        where: { email: session.user.email },
      });
    },
  },
});
```

Then set `handlerModule` in your config to point to your custom module:

```typescript
// ertk.config.ts
export default defineConfig({
  routes: {
    dir: "src/app/api",
    handlerModule: "@app/lib/ertk-handler",
  },
});
```

### Custom Error Handlers

Add ORM-specific or domain-specific error handling:

```typescript
import { configureHandler } from "ertk/next";
import { Prisma } from "@prisma/client";

export const createRouteHandler = configureHandler({
  auth: { /* ... */ },
  errorHandlers: [
    (error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") {
          return new Response(
            JSON.stringify({ error: "Not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return null; // Pass to next handler
    },
  ],
});
```

Error handlers are processed in order. The first handler to return a non-null `Response` wins. If no handler matches, ERTK falls back to built-in handling:

1. `ValidationError` → 400 with validation details
2. Errors with a numeric `status` property → uses that status code
3. All other errors → 500 with generic message (details logged server-side)

### Rate Limiting

ERTK provides server-side rate limiting for route handlers with a pluggable adapter system.

#### Global Configuration

Add a `rateLimit` option to `configureHandler()`:

```typescript
import { configureHandler } from "ertk/next";

export const createRouteHandler = configureHandler({
  auth: { /* ... */ },
  rateLimit: {
    windowMs: 60_000,  // 1 minute window
    max: 100,          // 100 requests per window
  },
});
```

When a request exceeds the limit, ERTK returns a `429 Too Many Requests` response with a `Retry-After` header and standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).

#### Per-Endpoint Overrides

Override the global `windowMs` and `max` on individual endpoints:

```typescript
export default endpoint.post<User, CreateUserInput>({
  name: "createUser",
  protected: false,
  rateLimit: { windowMs: 60_000, max: 5 },  // Stricter limit for registration
  // ...
});
```

Per-endpoint overrides take priority over the global config. The `keyFn` and `adapter` always come from the global config (or defaults). You can also set `rateLimit` on an endpoint without configuring a global rate limit — it will use the default IP-based key function and in-memory adapter.

#### Custom Key Function

By default, rate limiting is keyed by client IP (from `x-forwarded-for` or `x-real-ip` headers). Provide a custom `keyFn` to key by authenticated user, API key, or any other identifier:

```typescript
export const createRouteHandler = configureHandler({
  auth: { /* ... */ },
  rateLimit: {
    windowMs: 60_000,
    max: 100,
    keyFn: (req, user) => user?.id ?? defaultKeyFn(req),
  },
});
```

The `keyFn` receives the authenticated user when available (rate limiting runs after auth resolution).

#### Custom Adapter

The default `InMemoryRateLimitAdapter` uses a sliding window and is suitable for single-process deployments. For multi-instance or serverless deployments (e.g., Vercel), provide a distributed adapter:

```typescript
import { configureHandler, type RateLimitAdapter } from "ertk/next";

class UpstashRateLimitAdapter implements RateLimitAdapter {
  async check(key: string, windowMs: number, max: number) {
    // Your Upstash/Redis implementation
    return { allowed: true, limit: max, remaining: max - 1, resetAt: Date.now() / 1000 + windowMs / 1000 };
  }
}

export const createRouteHandler = configureHandler({
  rateLimit: {
    windowMs: 60_000,
    max: 100,
    adapter: new UpstashRateLimitAdapter(),
  },
});
```

The `RateLimitAdapter` interface requires a single `check(key, windowMs, max)` method that returns a `Promise<RateLimitResult>`:

```typescript
interface RateLimitResult {
  allowed: boolean;      // Whether the request is allowed
  limit: number;         // Total limit for the window
  remaining: number;     // Remaining requests in the current window
  resetAt: number;       // Unix timestamp (seconds) when the window resets
}
```

### Request Parsing

ERTK automatically handles request parsing based on the HTTP method:

- **GET, DELETE, HEAD, OPTIONS** — Parses `URLSearchParams` into an object (with automatic string-to-number coercion)
- **POST, PUT, PATCH** — Parses JSON request body

If a `request` schema is provided on the endpoint, the parsed data is validated through `schema.parse()` before reaching the handler.

### Handler Context

Every handler receives a context object:

```typescript
interface HandlerContext<TBody, TQuery, TUser> {
  user: TUser;        // Resolved user (from auth adapter)
  body: TBody;        // Parsed & validated request body
  query: TQuery;      // Parsed & validated query parameters
  params: Record<string, string>; // URL path parameters (Next.js dynamic segments)
  req: Request;       // Raw Request object
}
```

## Cache Tags

ERTK supports RTK Query's full tag system for automatic cache invalidation.

### Static Tags

```typescript
export default endpoint.get<Task[]>({
  name: "listTasks",
  tags: {
    provides: ["Tasks"],
  },
  // ...
});

export default endpoint.post<Task, CreateTaskInput>({
  name: "createTask",
  tags: {
    invalidates: ["Tasks"],
  },
  // ...
});
```

### Dynamic Tags

```typescript
export default endpoint.get<Task, { id: string }>({
  name: "getTask",
  tags: {
    provides: (result, _error, { id }) => [{ type: "Tasks", id }],
  },
  // ...
});

export default endpoint.put<Task, { id: string; title: string }>({
  name: "updateTask",
  tags: {
    invalidates: (_result, _error, { id }) => [
      { type: "Tasks", id },
      "Tasks",
    ],
  },
  // ...
});
```

Tag types are automatically extracted from your endpoint definitions and included in the generated `createApi({ tagTypes: [...] })` call.

## Optimistic Updates

ERTK supports declarative optimistic updates that generate the `onQueryStarted` boilerplate for you.

### Single Target

Update a single cached query when a mutation fires:

```typescript
export default endpoint.put<Task, { id: string; completed: boolean }>({
  name: "toggleTask",
  optimistic: {
    target: "listTasks",
    args: (params) => undefined,
    update: (draft, params) => {
      const tasks = draft as Task[];
      const task = tasks.find((t) => t.id === params.id);
      if (task) task.completed = params.completed;
    },
  },
  // ...
});
```

### Multi Target

Update multiple cached queries with optional conditions:

```typescript
export default endpoint.delete<void, { id: string; listId: string }>({
  name: "deleteTask",
  optimistic: {
    updates: [
      {
        target: "listTasks",
        args: (params) => undefined,
        update: (draft, params) => {
          const tasks = draft as Task[];
          const index = tasks.findIndex((t) => t.id === params.id);
          if (index !== -1) tasks.splice(index, 1);
        },
      },
      {
        target: "getTaskList",
        args: (params) => params.listId,
        update: (draft, params) => {
          const list = draft as TaskList;
          list.count -= 1;
        },
        condition: (params) => !!params.listId,
      },
    ],
  },
  // ...
});
```

The generated code automatically handles `queryFulfilled` awaiting and rolls back all patches on failure.

## Validation

ERTK works with any validation library that exposes a `.parse(data) => T` method.

### With Zod

```typescript
import { z } from "zod";

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

export default endpoint.post<Task, z.infer<typeof createTaskSchema>>({
  name: "createTask",
  request: createTaskSchema,
  // ...
});
```

### With Any `.parse()` Compatible Library

```typescript
const schema = {
  parse: (data: unknown) => {
    // Custom validation logic
    if (!data || typeof data !== "object") throw new Error("Invalid input");
    return data as MyType;
  },
};

export default endpoint.post<MyType, MyInput>({
  name: "createItem",
  request: schema,
  // ...
});
```

Validation errors are caught by the route handler and returned as 400 responses with structured error details when using Zod.

## API Reference

### `ertk` (Main Entry Point)

| Export | Type | Description |
|--------|------|-------------|
| `endpoint` | `object` | Factory with `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()` methods |
| `defineConfig` | `(config: ErtkConfig) => ErtkConfig` | Type-safe config wrapper |

### `ertk/next` (Next.js Entry Point)

| Export | Type | Description |
|--------|------|-------------|
| `configureHandler` | `(options?) => createRouteHandler` | Creates a configured route handler factory |
| `createRouteHandler` | `(def) => RequestHandler` | Default handler (no auth, no custom errors) |
| `ErtkAuthAdapter` | `interface` | Auth adapter shape: `{ getUser(req) => Promise<User \| null> }` |
| `ErtkErrorHandler` | `type` | Error handler: `(error) => Response \| null` |
| `ConfigureHandlerOptions` | `interface` | Options for `configureHandler` |
| `InMemoryRateLimitAdapter` | `class` | Sliding window rate limiter for single-process deployments |
| `defaultKeyFn` | `(req) => string` | Extracts client IP from proxy headers |
| `RateLimitAdapter` | `interface` | Adapter interface for custom storage backends |
| `RateLimitConfig` | `interface` | Rate limit configuration (`windowMs`, `max`, `keyFn?`, `adapter?`) |
| `RateLimitResult` | `interface` | Result of a rate limit check (`allowed`, `limit`, `remaining`, `resetAt`) |

### Types

| Type | Description |
|------|-------------|
| `EndpointDefinition<TResponse, TArgs>` | Main endpoint configuration interface |
| `HandlerContext<TBody, TQuery, TUser>` | Server-side handler context |
| `DefaultUser` | Minimal user shape (`{ id: string }`) |
| `ValidationSchema<T>` | Generic validation interface (`.parse()` compatible) |
| `TagType` | String tag identifier |
| `TagDescription` | Tag string or `{ type, id }` object |
| `SingleOptimistic<TArgs>` | Single-target optimistic update config |
| `MultiOptimistic<TArgs>` | Multi-target optimistic update config |
| `ErtkConfig` | User-facing config type |
| `ErtkRoutesConfig` | Route generation config type |

## Known Issues and Caveats

### Endpoint Parsing

- **Malformed endpoints are silently skipped.** If an endpoint file lacks a default export, an `endpoint.{method}()` call, or a `name` property, it is skipped with a `console.warn`. Check your terminal output if endpoints are missing from generated code.
- **AST extraction assumes standard patterns.** The parser expects `endpoint.get<...>({ ... })` call syntax directly. Wrapping in helper functions, using spread operators, or storing the config in a separate variable may not be detected.
- **Type imports are not transitively resolved.** Only types directly imported in the endpoint file are carried over to the generated `api.ts`. If your response type re-exports from another module, you may need to import the underlying type directly.

### Optimistic Updates

- **Parsed via regex, not AST.** The optimistic update extraction uses regex matching, which can break with unusual formatting, computed property names, or complex expressions inside `target`, `args`, or `update` fields. Keep optimistic configurations simple and well-formatted.

### Route Generation

- **Deleted endpoints don't clean up routes.** In watch mode, if you delete an endpoint file, the corresponding route handler file is not automatically removed. You'll need to delete stale route files manually or re-run a fresh `ertk generate` after cleaning the output directory.
- **Route path validation is minimal.** Generated route paths are derived from file paths without checking for special characters that could produce invalid Next.js route segments.

### General

- **`refetchOnFocus` and `refetchOnReconnect` are hardcoded.** The generated API sets `refetchOnFocus: false` and `refetchOnReconnect: true`. These are not yet configurable via `ertk.config.ts`.
- **No formatting of generated code.** Generated files use tabs and don't pass through Prettier or ESLint. Add generated paths to your formatter's include list if you want consistent style.
- **No test suite.** The package does not currently include automated tests.

### Rate Limiting

- **In-memory adapter resets on process restart.** The default `InMemoryRateLimitAdapter` stores state in memory. It resets when the process restarts and is not shared across instances. For serverless or multi-instance deployments, use a distributed adapter (Redis, Upstash, etc.).
- **Rate limiting runs after auth resolution.** This allows the `keyFn` to use the authenticated user for user-based rate limiting, but means auth work is performed before rate-limited requests are rejected.

## License

MIT
