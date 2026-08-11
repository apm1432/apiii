const nodemailer = require('nodemailer');
require('dotenv').config();

// Construct SMTP configs from individual ENV variables
const smtps = [
    {
        host: process.env.BREVO_SMTP_HOST,
        port: parseInt(process.env.BREVO_SMTP_PORT) || 587,
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASS,
        fromEmail: process.env.BREVO_FROM_EMAIL,
        fromName: process.env.BREVO_FROM_NAME,
        limit: 250 // Daily Limit
    },
    {
        host: process.env.BREVO_SMTP_HOST_1,
        port: parseInt(process.env.BREVO_SMTP_PORT_1) || 587,
        user: process.env.BREVO_SMTP_USER_1,
        pass: process.env.BREVO_SMTP_PASS_1,
        fromEmail: process.env.BREVO_FROM_EMAIL_1,
        fromName: process.env.BREVO_FROM_NAME_1,
        limit: 250
    }
];

// Third one as unlimited backup
const backupSmtp = {
    host: process.env.BREVO_SMTP_HOST_2,
    port: parseInt(process.env.BREVO_SMTP_PORT_2) || 587,
    user: process.env.BREVO_SMTP_USER_2,
    pass: process.env.BREVO_SMTP_PASS_2,
    fromEmail: process.env.BREVO_FROM_EMAIL_2,
    fromName: process.env.BREVO_FROM_NAME_2,
    limit: Infinity
};

// In-memory or DB tracking of SMTP usage
const smtpUsage = {}; // mapping { user: current_count }

/**
 * Assigns an SMTP to a newly subscribed user.
 */
function assignSmtpToUser() {
    for (const smtp of smtps) {
        if (!smtp.user) continue; // Skip if env var is missing
        
        const usage = smtpUsage[smtp.user] || 0;
        if (usage < smtp.limit) {
            return smtp.user; // Returning the username as identifier
        }
    }
    // If all limits reached, use backup
    return backupSmtp.user;
}

/**
 * Creates a Nodemailer transporter based on the user's assigned SMTP identifier.
 */
function getTransporter(assignedSmtpUser) {
    let selectedConfig = smtps.find(s => s.user === assignedSmtpUser);
    
    if (!selectedConfig) {
        selectedConfig = backupSmtp;
    }

    if (!selectedConfig.user) {
        throw new Error('No SMTP configuration available. Check ENV variables.');
    }

    return nodemailer.createTransport({
        host: selectedConfig.host,
        port: selectedConfig.port,
        secure: selectedConfig.port === 465, 
        auth: {
            user: selectedConfig.user,
            pass: selectedConfig.pass
        }
    });
}

function getFromAddress(assignedSmtpUser) {
    let selectedConfig = smtps.find(s => s.user === assignedSmtpUser) || backupSmtp;
    return `"${selectedConfig.fromName}" <${selectedConfig.fromEmail}>`;
}

/**
 * Sends an email, falling back to the backup SMTP if the assigned one fails.
 */
async function sendEmail(assignedSmtpUser, to, subject, text, html) {
    let transporter = getTransporter(assignedSmtpUser);
    const fromAddress = getFromAddress(assignedSmtpUser);
    
    try {
        const info = await transporter.sendMail({
            from: fromAddress,
            to,
            subject,
            text,
            html
        });
        
        // Increase usage count for this SMTP
        if (assignedSmtpUser !== backupSmtp.user) {
            smtpUsage[assignedSmtpUser] = (smtpUsage[assignedSmtpUser] || 0) + 1;
        }

        return info;
    } catch (err) {
        console.error(`Primary SMTP Failed for ${assignedSmtpUser}. Attempting Backup SMTP...`, err.message);
        
        if (backupSmtp.user && assignedSmtpUser !== backupSmtp.user) {
            transporter = getTransporter(backupSmtp.user);
            const backupFrom = getFromAddress(backupSmtp.user);
            const info = await transporter.sendMail({
                from: backupFrom,
                to,
                subject,
                text,
                html
            });
            return info;
        } else {
            throw new Error('All SMTP attempts failed.');
        }
    }
}

module.exports = {
    assignSmtpToUser,
    sendEmail
};
