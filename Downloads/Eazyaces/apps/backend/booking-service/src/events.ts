import { EventEmitter } from 'node:events';

export type BookingStatusChangedEvent = {
  bookingId: string;
  customerId: string;
  providerId: string;
  previousStatus: string;
  status: string;
  occurredAt: string;
};

export const bookingEvents = new EventEmitter();

bookingEvents.on('booking.status_changed', (event: BookingStatusChangedEvent) => {
  console.info('booking.status_changed', event);
});