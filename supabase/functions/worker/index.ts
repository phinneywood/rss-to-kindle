import { handleWorkerRequest } from "./core.ts";

Deno.serve(handleWorkerRequest);
