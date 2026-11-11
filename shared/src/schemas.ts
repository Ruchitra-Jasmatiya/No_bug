import { z } from 'zod';
import { LIMITS, MODULE_IDS } from './constants.js';

export const createTestSchema = z.object({
  url: z
    .string({ required_error: 'Please enter a valid website URL.' })
    .trim()
    .min(1, 'Please enter a valid website URL.')
    .max(LIMITS.maxUrlLength, 'Please enter a valid website URL.'),
  modules: z.array(z.enum(MODULE_IDS)).max(MODULE_IDS.length).optional(),
  /** The user must confirm they are allowed to test the target. */
  authorizationConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are authorised to test this website.' }),
  }),
  /** Lets a client safely retry a create request without making duplicate jobs. */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateTestInput = z.infer<typeof createTestSchema>;

export const uuidSchema = z.string().uuid();

export const progressQuerySchema = z.object({
  /** Return only logs with an id greater than this cursor. */
  after: z.coerce.number().int().min(0).default(0),
});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// ---------------------------------------------------------------------------------------------- auth
import { validatePassword } from './password.js';

export const emailSchema = z
  .string({ required_error: 'Please enter your email address.' })
  .trim()
  .toLowerCase()
  .min(3, 'Please enter a valid email address.')
  .max(254, 'Please enter a valid email address.')
  .email('Please enter a valid email address.');

const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^\+?[0-9][0-9 ()\-]{6,19}$/.test(v), 'Please enter a valid phone number.');

const OTP_PURPOSES = ['signup', 'password_reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
export const otpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.');

export const signupSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Please enter your full name.').max(80, 'Name is too long.'),
    email: emailSchema,
    phone: phoneSchema,
    password: z.string().max(128, 'Password must be at most 128 characters.'),
    confirmPassword: z.string(),
    termsAccepted: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy to continue.' }) }),
  })
  .superRefine((v, ctx) => {
    const problem = validatePassword(v.password, { email: v.email, name: v.fullName });
    if (problem) ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
    if (v.password !== v.confirmPassword) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match.' });
  });
export type SignupInput = z.infer<typeof signupSchema>;

export const verifyOtpSchema = z.object({ email: emailSchema, code: otpCodeSchema, purpose: z.enum(OTP_PURPOSES).default('signup') });
export const resendOtpSchema = z.object({ email: emailSchema, purpose: z.enum(OTP_PURPOSES).default('signup') });
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Please enter your password.').max(128, 'Incorrect email or password.'),
});
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z
  .object({ email: emailSchema, code: otpCodeSchema, newPassword: z.string().max(128), confirmPassword: z.string() })
  .superRefine((v, ctx) => {
    const problem = validatePassword(v.newPassword, { email: v.email });
    if (problem) ctx.addIssue({ code: 'custom', path: ['newPassword'], message: problem });
    if (v.newPassword !== v.confirmPassword) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match.' });
  });
