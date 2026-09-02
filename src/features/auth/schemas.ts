import { z } from 'zod'

/**
 * Validation is deliberately forgiving at sign-in and strict when setting a
 * password.
 *
 * Telling someone their password is "too short" while they are trying to log
 * in with a correct old password is unhelpful noise, and enumerating rules on
 * a login form leaks the password policy. So sign-in only checks that a value
 * is present; the server decides whether it is right.
 */
export const signInSchema = z.object({
  email: z
    .string()
    .min(1, 'Enter your email address')
    .email('Enter a valid email address, for example name@clinic.com'),
  password: z.string().min(1, 'Enter your password'),
})

export type SignInValues = z.infer<typeof signInSchema>

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .min(1, 'Enter your email address')
    .email('Enter a valid email address'),
})

export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>

/**
 * A length floor rather than a character-class maze. Composition rules push
 * people towards `Password1!`, which is weaker than a longer passphrase and
 * far harder to remember — the current NIST guidance is to require length and
 * screen against known-breached values instead.
 */
export const newPasswordSchema = z
  .object({
    password: z
      .string()
      .min(12, 'Use at least 12 characters — a short phrase works well')
      .max(72, 'Use no more than 72 characters'),
    confirmPassword: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'The two passwords do not match',
    path: ['confirmPassword'],
  })

export type NewPasswordValues = z.infer<typeof newPasswordSchema>
