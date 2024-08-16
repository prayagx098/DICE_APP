const Button = document.getElementById('roll');
const dice = document.getElementById('dice');
const audio = new Audio('dice.mp3');


function diceShow() {

    while (dice.firstChild) {
        dice.removeChild(dice.firstChild);
    }

    for (let i = 1; i <= 6; i++) {
        const face = document.createElement('div');
        face.classList.add('face', `face${i}`);
        face.textContent = i;
        dice.appendChild(face);
    }
}

window.onload = diceShow;

Button.addEventListener('click', () => {
    diceRoll();
});

function diceRoll() {
    audio.play();
    dice.classList.add('roll');

    const rand = Math.floor(Math.random() * 6) + 1;


    setTimeout(() => {
        dice.classList.remove('roll');
        const rotations = {
            1: 'rotateX(0deg) rotateY(0deg)',
            2: 'rotateX(0deg) rotateY(-90deg)',
            3: 'rotateX(0deg) rotateY(-180deg)',
            4: 'rotateX(0deg) rotateY(-270deg)',
            5: 'rotateX(-90deg) rotateY(0deg)',
            6: 'rotateX(90deg) rotateY(0deg)'
        };
        dice.style.transform = rotations[rand];
    }, 1000); 
}
