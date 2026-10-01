// External service providers. Each subfolder holds an interface, one implementation per vendor,
// a fake for tests, and a factory that picks the implementation from configuration.
//   vision/   FoodVisionProvider: snapcalorie | gemini | fake   (Phase 5.3)
//   email/    EmailProvider:      resend | fake                 (Phase 2.3)
//   push/     PushProvider:       fcm | fake                    (Phase 10.2)
//   storage/  StorageProvider:    s3 | fake                     (Phase 1.5)
export {};
