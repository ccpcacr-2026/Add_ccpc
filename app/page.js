import { redirect } from 'next/navigation';
// Public front door → applicant portal. Staff admin is at /app.html.
export default function Home() { redirect('/apply.html'); }
