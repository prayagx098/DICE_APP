const Button = document.getElementById('roll');
const dice = document.getElementById('dice');
const audio = new Audio('dice.mp3');


// Function to show the dice faces

function diceShow(){

    for(let i = 1; i <= 6; i++){

        const face = document.createElement('div');
        face.classList.add('face', `face${i}`);
        face.textContent = i;
        dice.appendChild(face);
        
    }

}


window.onload = diceShow;

Button.addEventListener('click', ()=>{
    diceRoll();
});

function diceRoll(){


    audio.play();

    dice.classList.add('roll');


    const rand = Math.floor(Math.random() * 6) + 1;


    setTimeout(() => {
        dice.classList.remove('roll');
        dice.style.transform = `rotateX(${rand * 90}deg)`;
    }, 600);
}
