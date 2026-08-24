//const axios = require("axios");
const AxiosDigestAuth = require("axios-digest-auth");

const CAMERA_IP = "192.168.1.2";
const USERNAME = "admin";
const PASSWORD = "admin";

const BASE_URL = `https://${CAMERA_IP}`;

const digestAuth = new AxiosDigestAuth({
    username: USERNAME,
    password: PASSWORD,
});

async function login() {
    const response = await digestAuth.request({
        method: "POST",

        url: `${BASE_URL}/API/Web/Login`,

        data: {
            data: {
                support_new_schedule: true,
                remote_terminal_info: "WEB,chrome"
            }
        },

        headers: {
            "Content-Type": "application/json"
        },

        httpsAgent: new (require("https").Agent)({
            rejectUnauthorized: false
        })
    });

    console.log("Status:", response.status);
    console.log("Headers:", response.headers);
    console.log("Body:", response.data);
}

login().catch(console.error);