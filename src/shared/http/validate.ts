// The validation layer. A route describes the input it accepts as a Zod schema
// and passes the raw input through validate():
//
//   const schema = z.strictObject({ weight_kg: z.number().min(20).max(400) });
//   const body = validate(schema, request.body);
//
// If the input fits, validate() returns it, typed. If it does not, it throws
// AppError('validation_failed') with one entry in `details` per problem, and
// the error handler answers 422.
//
// Rule: object schemas are written with z.strictObject, never z.object.
// strictObject rejects fields that are not in the schema, so a typo in a
// field name is reported instead of silently ignored (document 03 section 4).

import type { z } from 'zod';
import { AppError, type ErrorDetail } from './errors.js';

// Turns one problem reported by Zod into entries of our `details` list.
function toDetails(issue: z.core.$ZodIssue): ErrorDetail[] {
  // The path is the way to the field, for example ['address', 'city'].
  const field = issue.path.map(String).join('.');

  switch (issue.code) {
    case 'unrecognized_keys':
      // One Zod issue lists every unknown field of an object; we report each.
      return issue.keys.map((key) => ({
        field: field ? `${field}.${key}` : key,
        code: 'unknown_field',
        message: 'This field is not allowed.',
      }));

    case 'too_small':
    case 'too_big':
      return [{ field, code: 'out_of_range', message: issue.message }];

    case 'invalid_type':
      if (issue.input === undefined) {
        return [{ field, code: 'required', message: 'This field is required.' }];
      }
      return [{ field, code: 'invalid_type', message: issue.message }];

    default:
      return [{ field, code: 'invalid', message: issue.message }];
  }
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  // reportInput makes Zod include the offending value in each issue, which
  // toDetails uses to tell "missing" from "wrong type".
  const result = schema.safeParse(value, { reportInput: true });

  if (result.success) {
    return result.data;
  }

  throw new AppError('validation_failed', result.error.issues.flatMap(toDetails));
}
