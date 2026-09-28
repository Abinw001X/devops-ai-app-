export type RazorpayOrder = { keyId: string; orderId: string; amountPaise: number; currency: 'INR' };
export type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };

type CheckoutOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: { name: string; email: string; contact: string };
  theme: { color: string };
  config: {
    display: {
      blocks: Record<string, { name: string; instruments: { method: string }[] }>;
      sequence: string[];
      preferences: { show_default_blocks: boolean };
    };
  };
  handler: (response: RazorpayResponse) => void;
  modal: { ondismiss: () => void };
};

declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => { open: () => void };
  }
}

let scriptLoad: Promise<void> | undefined;

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = 'true';
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoad = undefined;
      reject(new Error('Payment checkout could not load. Check your connection and try again.'));
    };
    document.body.append(script);
  });
  return scriptLoad;
}

export async function openRazorpayCheckout({
  order,
  description,
  prefill,
  onSuccess,
  onDismiss,
}: {
  order: RazorpayOrder;
  description: string;
  prefill: { name: string; email: string; contact: string };
  onSuccess: (response: RazorpayResponse) => void;
  onDismiss: () => void;
}): Promise<void> {
  await loadRazorpay();
  if (!window.Razorpay) throw new Error('Payment checkout could not load. Try again.');
  const checkout = new window.Razorpay({
    key: order.keyId,
    amount: order.amountPaise,
    currency: order.currency,
    name: 'KaamSetu',
    description,
    order_id: order.orderId,
    prefill,
    theme: { color: '#1A56DB' },
    config: {
      display: {
        blocks: {
          upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] },
          other: { name: 'Cards and netbanking', instruments: [{ method: 'card' }, { method: 'netbanking' }] },
        },
        sequence: ['block.upi', 'block.other'],
        preferences: { show_default_blocks: false },
      },
    },
    handler: onSuccess,
    modal: { ondismiss: onDismiss },
  });
  checkout.open();
}