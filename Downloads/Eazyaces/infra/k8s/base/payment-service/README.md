# Payment API routing

There is no standalone payment-service process or image in the current source tree. Razorpay order, verification, refund, and payout endpoints are implemented by `booking-service`. The Ingress routes `/api/payments` to the booking-service ClusterIP Service. Do not create a second booking Deployment under this name; it would run the same complete API and could process the same events twice.

An independent payment Deployment and CPU HPA require a deliberate application/service extraction before they can be configured safely.
