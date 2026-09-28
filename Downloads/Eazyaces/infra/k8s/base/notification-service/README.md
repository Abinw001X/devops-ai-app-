# Notification API routing

There is no standalone notification-service process or image in the current source tree. Socket.IO, notification persistence, and `/api/notifications` are implemented by `booking-service`. The Ingress routes `/api/notifications` and `/socket.io` to the booking-service ClusterIP Service.

An independent notification Deployment requires a deliberate application/service extraction before it can be configured safely.
