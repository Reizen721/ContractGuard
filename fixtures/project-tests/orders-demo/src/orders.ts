export async function orderLabel() {
  const response = await fetch('/orders/current');
  const order = await response.json();
  return order.customerName.toUpperCase();
}

export async function orderReference() {
  const response = await fetch('/orders/current');
  const order = await response.json();
  return order.id;
}
