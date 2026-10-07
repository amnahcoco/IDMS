const loginForm = document.getElementById("loginForm");
const errorMessage = document.getElementById("errorMessage");

const correctEmail = "physicalsecurity@gbb.com.ng";
const correctPassword = "Password12";

loginForm.addEventListener("submit", function (event) {

    event.preventDefault();

    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    if (email === correctEmail && password === correctPassword) {

        window.location.href = "dashboard.html";

    } else {

        errorMessage.style.display = "block";

    }
});