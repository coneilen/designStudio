# DesignIR kernel vectors

Original synthetic canonical-serialization vectors for F02. These do not copy
or change the shared foundation snapshot, byte manifest, font or stripe PNG.
`packages/design-ir/tests/kernel.test.ts` compares the actual UTF-8 bytes against
the explicit canonical strings, preserving key, number and array-order rules.
The five foundation design/resource cases are consumed read-only by the kernel
unit and built-package smoke suites. No source imagery, rendered golden,
Figma/app capture, model output or approval is represented here.
