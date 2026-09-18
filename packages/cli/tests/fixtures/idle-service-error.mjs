import { registerHooks } from "node:module";

// Controlled test project owns no jobs, installation or user data. The service, API,
// control stream, error-path teardown record and process lifetime are the real code.
const projectModule = `export async function openInstalledProject(){return {
  application:async()=>({facade:{invoke:async()=>{throw new Error("No request admitted by fixture.");}},
    newClient:()=>({credential:"y".repeat(43)})}),
  close:async()=>true
};}`;
const url = `data:text/javascript,${encodeURIComponent(projectModule)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@design-studio/application/installed")
      return { url, shortCircuit: true };
    return next(specifier, context);
  },
});
const { serve } = await import("../../dist/service.js");
const { failure } = await import("@design-studio/application");
try {
  await serve(0, "3");
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(failure("service_stop", error.code))}\n`,
  );
  process.exitCode = 1;
}
